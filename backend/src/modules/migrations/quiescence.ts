import type { FastifyInstance } from 'fastify'
import type { AuthClaims } from '../../http/auth.js'

/**
 * Write-quiescence gate — Phase 5 dedicated tier.
 *
 * While a tenant is inside the migration window (`tenants.status =
 * 'migrating'`) every unsafe request that carries a Bearer token is refused
 * with 409 TENANT_MIGRATING. The design is deliberately in-memory-first:
 *
 *   - `pausedWrites` — per-process Set, populated by the migration machine
 *     BEFORE the status flip (`prepareMigration`), so on the initiating
 *     instance the gate NEVER consults the DB on the hot path.
 *   - DB `tenants.status` confirmation — when the local Set says "paused",
 *     the gate verifies the authoritative status before refusing, and
 *     self-heals the Set when the tenant has recovered (rollback/abort/
 *     cutover). This also makes the gate correct for windows started by a
 *     different process instance.
 *
 * Fast path stays DB-free: a tenant not paused locally skips the check
 * entirely (the far more common case). The residual exposure — a write racing
 * in on another instance inside the tiny window before its Set is populated —
 * is bounded: login/refresh already refuse non-'active' tenants on every
 * instance, so only already-authenticated sessions could slip through.
 *
 * Anonymous paths (signup / login / refresh) carry no token and are skipped.
 * The migration admin surface is exempted so the machine can advance a
 * migration while its own tenant is mid-window.
 */

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** `/tenants/:tenantId/migrations/...` — the platform-operator surface. */
const MIGRATION_ADMIN_RE = /^\/tenants\/[^/?]+\/migrations(?:\/|$)/

const pausedWrites = new Set<string>()

export function markTenantWritesPaused(tenantId: string): void {
  pausedWrites.add(tenantId)
}

export function markTenantWritesResumed(tenantId: string): void {
  pausedWrites.delete(tenantId)
}

export function registerQuiescenceGate(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', async (req, reply) => {
    if (!UNSAFE_METHODS.has(req.method)) return
    if (MIGRATION_ADMIN_RE.test(req.url)) return

    let claims: AuthClaims
    try {
      await req.jwtVerify()
      claims = req.user
    } catch {
      return // tokenless path (signup / login / refresh) — governed by auth
    }

    // Fast path: this instance never paused this tenant.
    if (!pausedWrites.has(claims.tenant)) return

    // Confirm against the authoritative status before refusing.
    const status = await fastify.db.system(async (q) => {
      const res = await q.query<{ status: string }>(`SELECT status FROM tenants WHERE id = $1`, [claims.tenant])
      return res.rows[0]?.status
    })
    if (status === 'migrating') {
      return reply.status(409).send({
        error: {
          code: 'TENANT_MIGRATING',
          message:
            'Tenant is being migrated to its dedicated schema — writes are paused until cutover completes',
        },
      })
    }
    // Tenant recovered (cutover / rollback / abort concluded) — un-pause.
    pausedWrites.delete(claims.tenant)
  })
}