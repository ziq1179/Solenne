/**
 * Integration Hub repository. CRUD queries for integration_connections.
 * All queries run within tenant-scoped transactions.
 */

import type { Q } from '../../db/index.js'
import { newId } from '../../db/index.js'

export interface IntegrationConnection {
  id: string
  tenantId: string
  provider: string
  label: string
  credentialEnc: string
  maskedPreview: string
  keyVersion: number
  status: string
  configJson: unknown
  lastVerifiedAt: string | null
  lastError: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateConnectionInput {
  provider: string
  label: string
  credentialEnc: string
  maskedPreview: string
  keyVersion: number
  status?: string
  configJson?: unknown
  createdBy: string
}

export interface UpdateConnectionInput {
  label?: string
  credentialEnc?: string
  maskedPreview?: string
  keyVersion?: number
  status?: string
  configJson?: unknown
  lastVerifiedAt?: string | null
  lastError?: string | null
}

export async function listConnections(q: Q): Promise<IntegrationConnection[]> {
  const { rows } = await q.query<IntegrationConnection>(
    `SELECT id, tenant_id AS "tenantId", provider, label,
            credential_enc AS "credentialEnc", masked_preview AS "maskedPreview",
            key_version AS "keyVersion", status,
            config_json AS "configJson", last_verified_at AS "lastVerifiedAt",
            last_error AS "lastError", created_by AS "createdBy",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM integration_connections
     ORDER BY created_at DESC`,
  )
  return rows
}

export async function getConnection(q: Q, id: string): Promise<IntegrationConnection | null> {
  const { rows } = await q.query<IntegrationConnection>(
    `SELECT id, tenant_id AS "tenantId", provider, label,
            credential_enc AS "credentialEnc", masked_preview AS "maskedPreview",
            key_version AS "keyVersion", status,
            config_json AS "configJson", last_verified_at AS "lastVerifiedAt",
            last_error AS "lastError", created_by AS "createdBy",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM integration_connections WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}

export async function getConnectionsByProvider(q: Q, provider: string): Promise<IntegrationConnection[]> {
  const { rows } = await q.query<IntegrationConnection>(
    `SELECT id, tenant_id AS "tenantId", provider, label,
            credential_enc AS "credentialEnc", masked_preview AS "maskedPreview",
            key_version AS "keyVersion", status,
            config_json AS "configJson", last_verified_at AS "lastVerifiedAt",
            last_error AS "lastError", created_by AS "createdBy",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM integration_connections WHERE provider = $1`,
    [provider],
  )
  return rows
}

export async function createConnection(q: Q, input: CreateConnectionInput): Promise<IntegrationConnection> {
  const id = newId()
  const { rows } = await q.query<IntegrationConnection>(
    `INSERT INTO integration_connections
       (id, tenant_id, provider, label, credential_enc, masked_preview, key_version, status, config_json, created_by)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING id, tenant_id AS "tenantId", provider, label,
               credential_enc AS "credentialEnc", masked_preview AS "maskedPreview",
               key_version AS "keyVersion", status,
               config_json AS "configJson", last_verified_at AS "lastVerifiedAt",
               last_error AS "lastError", created_by AS "createdBy",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      id,
      input.provider,
      input.label,
      input.credentialEnc,
      input.maskedPreview,
      input.keyVersion,
      input.status ?? 'disconnected',
      input.configJson ? JSON.stringify(input.configJson) : null,
      input.createdBy,
    ],
  )
  return rows[0] as IntegrationConnection
}

export async function updateConnection(q: Q, id: string, input: UpdateConnectionInput): Promise<IntegrationConnection | null> {
  const sets: string[] = []
  const params: unknown[] = []
  let idx = 1

  if (input.label !== undefined) { sets.push(`label = $${idx++}`); params.push(input.label) }
  if (input.credentialEnc !== undefined) { sets.push(`credential_enc = $${idx++}`); params.push(input.credentialEnc) }
  if (input.maskedPreview !== undefined) { sets.push(`masked_preview = $${idx++}`); params.push(input.maskedPreview) }
  if (input.keyVersion !== undefined) { sets.push(`key_version = $${idx++}`); params.push(input.keyVersion) }
  if (input.status !== undefined) { sets.push(`status = $${idx++}`); params.push(input.status) }
  if (input.configJson !== undefined) { sets.push(`config_json = $${idx++}::jsonb`); params.push(JSON.stringify(input.configJson)) }
  if (input.lastVerifiedAt !== undefined) { sets.push(`last_verified_at = $${idx++}`); params.push(input.lastVerifiedAt) }
  if (input.lastError !== undefined) { sets.push(`last_error = $${idx++}`); params.push(input.lastError) }

  if (sets.length === 0) return getConnection(q, id)

  sets.push(`updated_at = now()`)
  params.push(id)

  const { rows } = await q.query<IntegrationConnection>(
    `UPDATE integration_connections SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING id, tenant_id AS "tenantId", provider, label,
               credential_enc AS "credentialEnc", masked_preview AS "maskedPreview",
               key_version AS "keyVersion", status,
               config_json AS "configJson", last_verified_at AS "lastVerifiedAt",
               last_error AS "lastError", created_by AS "createdBy",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    params,
  )
  return rows[0] ?? null
}

export async function deleteConnection(q: Q, id: string): Promise<boolean> {
  // Soft-delete: wipe credential, set status to disconnected
  await q.exec(
    `UPDATE integration_connections
     SET status = 'disconnected', credential_enc = '', masked_preview = '', updated_at = now()
     WHERE id = $1`,
    [id],
  )
  const { rows } = await q.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM integration_connections WHERE id = $1 AND status = 'disconnected') AS "exists"`,
    [id],
  )
  return rows[0]?.exists ?? false
}

/** For dispatch: get a connected credential (decrypts in-memory only). */
export async function getConnectedByProvider(q: Q, provider: string): Promise<{ id: string; credentialEnc: string } | null> {
  const { rows } = await q.query<{ id: string; credentialEnc: string }>(
    `SELECT id, credential_enc AS "credentialEnc"
     FROM integration_connections
     WHERE provider = $1 AND status = 'connected' AND credential_enc != ''
     LIMIT 1`,
    [provider],
  )
  return rows[0] ?? null
}
