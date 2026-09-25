import type { Q } from '../../db/index.js'

export interface TenantRow {
  id: string
  name: string
  subdomain: string
  plan: string
  status: string
  /** 'shared' | 'dedicated_schema' — set once the Phase 5 tier has flipped. */
  isolationMode: string
  /** The tenant's dedicated schema name when isolationMode === 'dedicated_schema'. */
  dedicatedSchema: string | null
}

export interface UserAuthRow {
  id: string
  tenantId: string
  email: string
  passwordHash: string
  status: string
  mfaEnabled: boolean
  employeeId: string | null
}

export interface RefreshTokenRow {
  id: string
  userId: string
  tenantId: string
  expiresAt: string
  revokedAt: string | null
}

export async function findTenantBySubdomain(q: Q, subdomain: string): Promise<TenantRow | null> {
  const { rows } = await q.query<TenantRow>(
    `SELECT id, name, subdomain, plan, status,
            isolation_mode AS "isolationMode",
            dedicated_schema AS "dedicatedSchema"
     FROM tenants
     WHERE lower(subdomain) = lower($1) AND deleted_at IS NULL`,
    [subdomain],
  )
  return rows[0] ?? null
}

export async function findTenantById(q: Q, id: string): Promise<TenantRow | null> {
  const { rows } = await q.query<TenantRow>(
    `SELECT id, name, subdomain, plan, status,
            isolation_mode AS "isolationMode",
            dedicated_schema AS "dedicatedSchema"
     FROM tenants
     WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  )
  return rows[0] ?? null
}

export async function findUserByEmail(q: Q, tenantId: string, email: string): Promise<UserAuthRow | null> {
  const { rows } = await q.query<UserAuthRow>(
    `SELECT u.id, u.tenant_id AS "tenantId", u.email, u.password_hash AS "passwordHash",
            u.status, u.mfa_enabled AS "mfaEnabled",
            e.id AS "employeeId"
     FROM user_accounts u
     LEFT JOIN employees e ON e.user_account_id = u.id
     WHERE u.tenant_id = $1 AND lower(u.email) = lower($2) AND u.deleted_at IS NULL`,
    [tenantId, email],
  )
  return rows[0] ?? null
}

export async function listRolesForUser(q: Q, tenantId: string, userId: string): Promise<string[]> {
  const { rows } = await q.query<{ name: string }>(
    `SELECT DISTINCT r.name
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
     WHERE ur.user_id = $1 AND ur.tenant_id = $2
     ORDER BY r.name`,
    [userId, tenantId],
  )
  return rows.map((r) => r.name)
}

export async function listPermissionsForUser(q: Q, tenantId: string, userId: string): Promise<string[]> {
  const { rows } = await q.query<{ code: string }>(
    `SELECT DISTINCT p.code
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1 AND ur.tenant_id = $2
     ORDER BY p.code`,
    [userId, tenantId],
  )
  return rows.map((r) => r.code)
}

export async function touchLastLogin(q: Q, userId: string): Promise<void> {
  await q.exec(`UPDATE user_accounts SET last_login_at = now() WHERE id = $1`, [userId])
}

// refresh_tokens is PUBLIC-qualified everywhere: the auth flow deliberately
// runs tenant-scoped reads against the dedicated schema (post-cutover), but
// the token ledger itself always lives in the shared `public` schema so this
// session's rotation is not per-tenant.
export async function insertRefreshToken(
  q: Q,
  tenantId: string,
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await q.exec(
    `INSERT INTO public.refresh_tokens (id, tenant_id, user_id, token_hash, expires_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
    [tenantId, userId, tokenHash, expiresAt],
  )
}

export async function findRefreshToken(q: Q, tokenHash: string): Promise<RefreshTokenRow | null> {
  const { rows } = await q.query<RefreshTokenRow>(
    `SELECT id, user_id AS "userId", tenant_id AS "tenantId",
            expires_at::text AS "expiresAt", revoked_at::text AS "revokedAt"
     FROM public.refresh_tokens
     WHERE token_hash = $1`,
    [tokenHash],
  )
  return rows[0] ?? null
}

export async function revokeRefreshToken(q: Q, id: string): Promise<void> {
  await q.exec(`UPDATE public.refresh_tokens SET revoked_at = now() WHERE id = $1`, [id])
}

export async function findUserById(q: Q, tenantId: string, userId: string): Promise<UserAuthRow | null> {
  const { rows } = await q.query<UserAuthRow>(
    `SELECT u.id, u.tenant_id AS "tenantId", u.email, u.password_hash AS "passwordHash",
            u.status, u.mfa_enabled AS "mfaEnabled",
            e.id AS "employeeId"
     FROM user_accounts u
     LEFT JOIN employees e ON e.user_account_id = u.id
     WHERE u.tenant_id = $1 AND u.id = $2 AND u.deleted_at IS NULL`,
    [tenantId, userId],
  )
  return rows[0] ?? null
}