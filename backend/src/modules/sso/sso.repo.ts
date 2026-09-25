/**
 * SSO repository. Reads/writes sso_config_json on tenants, looks up users
 * by employees.work_email, manages client secret in integration_connections.
 */

import type { Q } from '../../db/index.js'
import { newId } from '../../db/index.js'
import { encryptCredential, serializeCredential, maskCredential, decryptCredential, parseCredential } from '../../lib/credential-encryption.js'

export interface TenantSsoRow {
  id: string
  ssoConfigJson: Record<string, unknown> | null
}

export interface SsoUserMatch {
  userId: string
  employeeId: string
  email: string
  status: string
  roles: string[]
  permissions: string[]
}

/** Read SSO config for a tenant. */
export async function getSsoConfig(q: Q, tenantId: string): Promise<TenantSsoRow | null> {
  const { rows } = await q.query<TenantSsoRow>(
    `SELECT id, sso_config_json AS "ssoConfigJson"
     FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
    [tenantId],
  )
  return rows[0] ?? null
}

/** Write SSO config for a tenant. */
export async function setSsoConfig(q: Q, tenantId: string, config: Record<string, unknown>): Promise<void> {
  await q.exec(
    `UPDATE tenants SET sso_config_json = $2::jsonb, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL`,
    [tenantId, JSON.stringify(config)],
  )
}

/** Clear SSO config for a tenant. */
export async function clearSsoConfig(q: Q, tenantId: string): Promise<void> {
  await q.exec(
    `UPDATE tenants SET sso_config_json = NULL, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL`,
    [tenantId],
  )
}

/** Store encrypted client secret in integration_connections. */
export async function storeClientSecret(
  q: Q,
  tenantId: string,
  secret: string,
  masterKey: Buffer,
  keyVersion: number,
): Promise<void> {
  const encrypted = encryptCredential(secret, masterKey, keyVersion)
  const serialized = serializeCredential(encrypted)
  const masked = maskCredential(secret)

  // Upsert: delete existing, then insert
  await q.exec(
    `DELETE FROM integration_connections
     WHERE tenant_id = $1 AND provider = 'sso_client_secret'`,
    [tenantId],
  )
  await q.exec(
    `INSERT INTO integration_connections
       (id, tenant_id, provider, label, credential_enc, masked_preview, key_version, status, created_by)
     VALUES ($1, $2, 'sso_client_secret', $6, $3, $4, $5, 'connected',
       (SELECT id FROM user_accounts WHERE tenant_id = $2 LIMIT 1))`,
    [newId(), tenantId, serialized, masked, keyVersion, 'sso_client_secret'],
  )
}

/** Retrieve and decrypt client secret from integration_connections. */
export async function getClientSecret(q: Q, tenantId: string, masterKey: Buffer): Promise<string | null> {
  const { rows } = await q.query<{ credentialEnc: string }>(
    `SELECT credential_enc AS "credentialEnc"
     FROM integration_connections
     WHERE tenant_id = $1 AND provider = 'sso_client_secret' AND credential_enc != ''
     LIMIT 1`,
    [tenantId],
  )
  if (!rows[0]) return null
  const parsed = parseCredential(rows[0].credentialEnc)
  return decryptCredential(parsed, masterKey)
}

/** Delete client secret from integration_connections. */
export async function deleteClientSecret(q: Q, tenantId: string): Promise<void> {
  await q.exec(
    `DELETE FROM integration_connections
     WHERE tenant_id = $1 AND provider = 'sso_client_secret'`,
    [tenantId],
  )
}

/** Check if a client secret is configured (without decrypting). */
export async function hasClientSecret(q: Q, tenantId: string): Promise<boolean> {
  const { rows } = await q.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM integration_connections
       WHERE tenant_id = $1 AND provider = 'sso_client_secret' AND credential_enc != ''
     ) AS "exists"`,
    [tenantId],
  )
  return rows[0]?.exists ?? false
}

/** Look up user by employees.work_email with role/permission loading. */
export async function findUserByWorkEmail(
  q: Q,
  tenantId: string,
  email: string,
): Promise<SsoUserMatch | null> {
  const { rows } = await q.query<SsoUserMatch>(
    `SELECT u.id AS "userId", e.id AS "employeeId", u.email, u.status,
            COALESCE(
              (SELECT json_agg(r.name) FROM user_roles ur
               JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
               WHERE ur.user_id = u.id AND ur.tenant_id = $1),
              '[]'
            ) AS "roles",
            COALESCE(
              (SELECT json_agg(p.code) FROM user_roles ur
               JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
               JOIN role_permissions rp ON rp.role_id = r.id
               JOIN permissions p ON p.id = rp.permission_id
               WHERE ur.user_id = u.id AND ur.tenant_id = $1),
              '[]'
            ) AS "permissions"
     FROM user_accounts u
     JOIN employees e ON e.user_account_id = u.id
     WHERE u.tenant_id = $1 AND lower(e.work_email) = lower($2)
       AND u.deleted_at IS NULL AND e.employment_status = 'active'
     LIMIT 1`,
    [tenantId, email],
  )
  return rows[0] ?? null
}

/** Check if at least one admin has a verifiable SSO identity (work_email exists). */
export async function hasAdminWithWorkEmail(q: Q, tenantId: string): Promise<boolean> {
  const { rows } = await q.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM user_accounts u
       JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
       JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
       JOIN employees e ON e.user_account_id = u.id
       WHERE u.tenant_id = $1 AND r.name = 'admin'
         AND e.work_email IS NOT NULL AND e.work_email != ''
         AND u.status = 'active' AND u.deleted_at IS NULL
     ) AS "exists"`,
    [tenantId],
  )
  return rows[0]?.exists ?? false
}
