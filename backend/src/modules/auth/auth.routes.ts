import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { newOpaqueToken, scryptHash, scryptVerify, sha256Hex } from '../../lib/crypto.js'
import { parseDuration } from '../../lib/duration.js'
import * as repo from './auth.repo.js'
import * as ssoRepo from '../sso/sso.repo.js'

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantSubdomain: z.string().min(1).max(80),
})

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})

export function registerAuthRoutes(fastify: FastifyInstance): void {
  const { db, config } = fastify
  const accessTtlSeconds = parseDuration(config.jwtExpires)

  fastify.post('/auth/login', async (req, reply) => {
    const body = loginSchema.safeParse(req.body)
    if (!body.success) throw httpError.badRequest('Invalid login payload', body.error.flatten())
    const { email, password, tenantSubdomain } = body.data

    // Phase 1 — tenancy resolution (shared `public` only).
    const tenant = await db.system(async (q) => {
      const t = await repo.findTenantBySubdomain(q, tenantSubdomain)
      if (!t || t.status !== 'active') throw httpError.unauthorized('Invalid credentials')
      return t
    })

    // enforceSso check: if the tenant has SSO enabled with enforceSso=true, reject password login
    const ssoConfig = await db.system(async (q) => ssoRepo.getSsoConfig(q, tenant.id))
    if (ssoConfig?.ssoConfigJson) {
      const { parseSsoConfig } = await import('../sso/sso.config.js')
      const parsed = parseSsoConfig(ssoConfig.ssoConfigJson as Record<string, unknown>)
      if (parsed.enforceSso) {
        throw httpError.forbidden(
          'Password login is disabled for this tenant. Please use SSO authentication.',
        )
      }
    }

    // Phase 2 — credential + role resolution. A dedicated tenant resolves the
    // user/roles/permissions from its OWN schema (post-cutover the shared
    // `public` copy is purged), via search_path scoping.
    const scoped = tenant.isolationMode === 'dedicated_schema' ? { schema: tenant.dedicatedSchema! } : undefined
    const result = await db.system(async (q) => {
      const user = await repo.findUserByEmail(q, tenant.id, email)
      if (!user || user.status !== 'active') throw httpError.unauthorized('Invalid credentials')

      const valid = await scryptVerify(password, user.passwordHash)
      if (!valid) throw httpError.unauthorized('Invalid credentials')

      const [roles, permissions] = await Promise.all([
        repo.listRolesForUser(q, tenant.id, user.id),
        repo.listPermissionsForUser(q, tenant.id, user.id),
      ])
      await repo.touchLastLogin(q, user.id)

      const refreshToken = newOpaqueToken()
      await repo.insertRefreshToken(
        q,
        tenant.id,
        user.id,
        sha256Hex(refreshToken),
        new Date(Date.now() + config.refreshExpiresDays * 86_400_000),
      )
      return { user, roles, permissions, refreshToken }
    }, scoped)

    const token = fastify.jwt.sign(
      {
        sub: result.user.id,
        tenant: tenant.id,
        employeeId: result.user.employeeId,
        roles: result.roles,
        permissions: result.permissions,
        isolationMode: tenant.isolationMode,
        tenantSchema: tenant.isolationMode === 'dedicated_schema' ? (tenant.dedicatedSchema ?? undefined) : undefined,
      },
      { expiresIn: config.jwtExpires },
    )

    return {
      accessToken: token,
      refreshToken: result.refreshToken,
      expiresIn: accessTtlSeconds,
    }
  })

  fastify.post('/auth/refresh', async (req) => {
    const body = refreshSchema.safeParse(req.body)
    if (!body.success) throw httpError.badRequest('Invalid refresh payload', body.error.flatten())
    const tokenHash = sha256Hex(body.data.refreshToken)

    // Phase 1 — token + tenancy resolution (shared `public` only).
    const { token, tenant } = await db.system(async (q) => {
      const t = await repo.findRefreshToken(q, tokenHash)
      if (!t || t.revokedAt || new Date(t.expiresAt) < new Date()) {
        throw httpError.unauthorized('Refresh token is invalid or expired')
      }
      const tenantRow = await repo.findTenantById(q, t.tenantId)
      if (!tenantRow || tenantRow.status !== 'active') throw httpError.unauthorized('Tenant is not active')
      return { token: t, tenant: tenantRow }
    })

    // Phase 2 — rotate against the tenant's authoritative schema.
    const scoped = tenant.isolationMode === 'dedicated_schema' ? { schema: tenant.dedicatedSchema! } : undefined
    const result = await db.system(async (q) => {
      const user = await repo.findUserById(q, token.tenantId, token.userId)
      if (!user || user.status !== 'active') throw httpError.unauthorized('User is not active')

      const [roles, permissions] = await Promise.all([
        repo.listRolesForUser(q, token.tenantId, user.id),
        repo.listPermissionsForUser(q, token.tenantId, user.id),
      ])

      // Rotate: old token dies, a fresh one is issued.
      await repo.revokeRefreshToken(q, token.id)
      const refreshToken = newOpaqueToken()
      await repo.insertRefreshToken(
        q,
        token.tenantId,
        user.id,
        sha256Hex(refreshToken),
        new Date(Date.now() + config.refreshExpiresDays * 86_400_000),
      )

      return { user, roles, permissions, refreshToken }
    }, scoped)

    const accessToken = fastify.jwt.sign(
      {
        sub: result.user.id,
        tenant: token.tenantId,
        employeeId: result.user.employeeId,
        roles: result.roles,
        permissions: result.permissions,
        isolationMode: tenant.isolationMode,
        tenantSchema: tenant.isolationMode === 'dedicated_schema' ? (tenant.dedicatedSchema ?? undefined) : undefined,
      },
      { expiresIn: config.jwtExpires },
    )

    return { accessToken, refreshToken: result.refreshToken, expiresIn: accessTtlSeconds }
  })

  fastify.get(
    '/auth/me',
    { preHandler: [authenticate] },
    async (req) => {
      const id = req.ctx.userId
      const tenantId = req.ctx.tenantId
      return db.tenant(tenantId, async (q) => {
        const user = await repo.findUserById(q, tenantId, id)
        if (!user) throw httpError.unauthorized('User account no longer exists')
        const [roles, permissions] = await Promise.all([
          repo.listRolesForUser(q, tenantId, user.id),
          repo.listPermissionsForUser(q, tenantId, user.id),
        ])
        return {
          id: user.id,
          email: user.email,
          employeeId: user.employeeId,
          roles,
          permissions,
        }
      })
    },
  )
}
