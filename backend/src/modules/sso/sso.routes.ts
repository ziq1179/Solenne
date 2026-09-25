import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { audit } from '../../lib/audit.js'
import { PERMISSIONS } from '../permissions.js'
import { parseSsoConfig } from './sso.config.js'
import { buildAuthorizeUrl, exchangeCode, randomState } from './oidc-provider.js'
import * as repo from './sso.repo.js'

const configureSsoSchema = z.object({
  discoveryUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  allowedEmailDomains: z.array(z.string()).optional(),
  defaultRole: z.string().min(1).optional(),
  enforceSso: z.boolean().optional(),
})

export function registerSsoRoutes(fastify: FastifyInstance): void {
  const { db, config } = fastify

  // ── GET /tenants/:id/sso — read SSO config ─────────────────────────────────
  fastify.get(
    '/tenants/:id/sso',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.TENANT_READ)] },
    async (req) => {
      const { id } = req.params as { id: string }
      // tenants is a global table — read via db.system()
      const tenant = await db.system(async (q) => repo.getSsoConfig(q, id))
      if (!tenant) throw httpError.notFound('Tenant not found')

      const ssoConfig = tenant.ssoConfigJson
      if (!ssoConfig) {
        return { enabled: false }
      }

      const parsed = parseSsoConfig(ssoConfig as Record<string, unknown>)
      const secretConfigured = await db.tenant(id, (q) => repo.hasClientSecret(q, id))

      return {
        enabled: true,
        provider: parsed.provider,
        discoveryUrl: parsed.discoveryUrl,
        clientId: parsed.clientId,
        scopes: parsed.scopes,
        allowedEmailDomains: parsed.allowedEmailDomains,
        defaultRole: parsed.defaultRole,
        enforceSso: parsed.enforceSso,
        clientSecretConfigured: secretConfigured,
      }
    },
  )

  // ── PATCH /tenants/:id/sso — enable/configure SSO ─────────────────────────
  fastify.patch(
    '/tenants/:id/sso',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.TENANT_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      const parsed = configureSsoSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid SSO config', parsed.error.flatten())

      const masterKey = config.integrationHubKey as Buffer | undefined
      if (!masterKey) throw httpError.badRequest('Integration Hub encryption key not configured (INTEGRATION_HUB_KEY)')

      const existing = await db.system(async (q) => repo.getSsoConfig(q, id))
      if (!existing) throw httpError.notFound('Tenant not found')

      const ssoConfig = parseSsoConfig({
        provider: 'oidc',
        discoveryUrl: parsed.data.discoveryUrl,
        clientId: parsed.data.clientId,
        scopes: parsed.data.scopes,
        allowedEmailDomains: parsed.data.allowedEmailDomains,
        defaultRole: parsed.data.defaultRole ?? 'employee',
        enforceSso: parsed.data.enforceSso ?? false,
      })

      // If toggling enforceSso to true, check lockout guard
      if (ssoConfig.enforceSso) {
        const currentConfig = existing.ssoConfigJson as Record<string, unknown> | null
        const wasEnforced = currentConfig?.enforceSso === true
        if (!wasEnforced) {
          const hasAdmin = await db.system(async (q) => repo.hasAdminWithWorkEmail(q, id))
          if (!hasAdmin) {
            throw httpError.badRequest(
              'Cannot enforce SSO: no admin account has a verifiable SSO identity. ' +
              'Ensure at least one admin has a work email configured before enabling enforceSso.',
            )
          }
        }
      }

      // Write SSO config to tenants table (global table, needs db.system)
      await db.system(async (q) => repo.setSsoConfig(q, id, ssoConfig as unknown as Record<string, unknown>))

      // Store encrypted client secret in integration_connections (tenant-scoped)
      const keyVersion = config.currentKeyVersion as number
      await db.tenant(id, (q) => repo.storeClientSecret(q, id, parsed.data.clientSecret, masterKey, keyVersion))

      // Audit log (tenant-scoped)
      await db.tenant(id, (q) => audit(q, {
        tenantId: id,
        actorType: 'user',
        actorId: req.ctx.userId,
        action: 'tenant.sso.configured',
        entityType: 'tenant',
        entityId: id,
        after: { provider: 'oidc', enforceSso: ssoConfig.enforceSso },
      }))

      const secretConfigured = await db.tenant(id, (q) => repo.hasClientSecret(q, id))
      return {
        enabled: true,
        provider: ssoConfig.provider,
        discoveryUrl: ssoConfig.discoveryUrl,
        clientId: ssoConfig.clientId,
        scopes: ssoConfig.scopes,
        allowedEmailDomains: ssoConfig.allowedEmailDomains,
        defaultRole: ssoConfig.defaultRole,
        enforceSso: ssoConfig.enforceSso,
        clientSecretConfigured: secretConfigured,
      }
    },
  )

  // ── DELETE /tenants/:id/sso — disable SSO ─────────────────────────────────
  fastify.delete(
    '/tenants/:id/sso',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.TENANT_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }

      const existing = await db.system(async (q) => repo.getSsoConfig(q, id))
      if (!existing) throw httpError.notFound('Tenant not found')
      if (!existing.ssoConfigJson) {
        return { disabled: true, message: 'SSO was not configured' }
      }

      // Clear SSO config (global table) and delete client secret (tenant-scoped)
      await db.system(async (q) => repo.clearSsoConfig(q, id))
      await db.tenant(id, (q) => repo.deleteClientSecret(q, id))

      // Audit log (tenant-scoped)
      await db.tenant(id, (q) => audit(q, {
        tenantId: id,
        actorType: 'user',
        actorId: req.ctx.userId,
        action: 'tenant.sso.disabled',
        entityType: 'tenant',
        entityId: id,
        before: { provider: (existing.ssoConfigJson as Record<string, unknown>)?.provider },
      }))

      return { disabled: true }
    },
  )

  // ── GET /auth/sso/login — redirect to IdP ──────────────────────────────────
  fastify.get('/auth/sso/login', async (req, reply) => {
    const qs = req.query as Record<string, string | undefined>
    const tenantSubdomain = qs.tenant
    if (!tenantSubdomain) throw httpError.badRequest('Missing tenant parameter')

    const tenant = await db.system(async (q) => {
      const { rows } = await q.query<{ id: string; ssoConfigJson: Record<string, unknown> | null }>(
        `SELECT id, sso_config_json AS "ssoConfigJson"
         FROM tenants WHERE lower(subdomain) = lower($1) AND deleted_at IS NULL AND status = 'active'`,
        [tenantSubdomain],
      )
      return rows[0] ?? null
    })

    if (!tenant || !tenant.ssoConfigJson) {
      throw httpError.badRequest('SSO is not configured for this tenant')
    }

    const ssoConfig = parseSsoConfig(tenant.ssoConfigJson)
    const state = randomState()
    const callbackUrl = `${config.integrationHubKey ? (qs.base_url as string || 'http://localhost:4000') : 'http://localhost:4000'}/auth/sso/callback`

    reply.setCookie('sso_state', state, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 300,
    })
    reply.setCookie('sso_tenant', tenantSubdomain, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 300,
    })

    const authorizeUrl = buildAuthorizeUrl(ssoConfig, state, callbackUrl)
    return reply.redirect(authorizeUrl)
  })

  // ── POST /auth/sso/callback — exchange code for JWT ────────────────────────
  fastify.post('/auth/sso/callback', async (req) => {
    const body = req.body as Record<string, string> | undefined
    const code = body?.code
    const state = body?.state

    if (!code || !state) throw httpError.badRequest('Missing code or state parameter')

    const cookieState = (req.cookies as Record<string, string>)?.sso_state
    const tenantSubdomain = (req.cookies as Record<string, string>)?.sso_tenant

    if (!cookieState || !tenantSubdomain) {
      throw httpError.badRequest('Missing SSO session cookies. Please restart the login flow.')
    }
    if (cookieState !== state) {
      throw httpError.forbidden('CSRF state mismatch. Please restart the login flow.')
    }

    const tenant = await db.system(async (q) => {
      const { rows } = await q.query<{ id: string; ssoConfigJson: Record<string, unknown> | null }>(
        `SELECT id, sso_config_json AS "ssoConfigJson"
         FROM tenants WHERE lower(subdomain) = lower($1) AND deleted_at IS NULL AND status = 'active'`,
        [tenantSubdomain],
      )
      return rows[0] ?? null
    })

    if (!tenant || !tenant.ssoConfigJson) {
      throw httpError.badRequest('SSO is not configured for this tenant')
    }

    const ssoConfig = parseSsoConfig(tenant.ssoConfigJson)

    const masterKey = config.integrationHubKey as Buffer | undefined
    if (!masterKey) throw httpError.internal('Encryption key not configured')

    const clientSecret = await db.tenant(tenant.id, (q) => repo.getClientSecret(q, tenant.id, masterKey))
    if (!clientSecret) throw httpError.internal('SSO client secret not found')

    const callbackUrl = `${req.protocol}://${req.hostname}/auth/sso/callback`

    let claims
    try {
      claims = await exchangeCode(code, { ...ssoConfig, clientId: ssoConfig.clientId }, callbackUrl, state)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw httpError.unauthorized(`SSO authentication failed: ${message}`)
    }

    const emailDomain = claims.email.split('@')[1]?.toLowerCase()
    if (!emailDomain) {
      throw httpError.unauthorized('SSO authentication failed: invalid email format')
    }
    if (ssoConfig.allowedEmailDomains.length > 0) {
      if (!ssoConfig.allowedEmailDomains.includes(emailDomain)) {
        throw httpError.forbidden(
          `Email domain ${emailDomain} is not authorized for SSO on this tenant. ` +
          `Allowed domains: ${ssoConfig.allowedEmailDomains.join(', ')}`,
        )
      }
    }

    const user = await db.tenant(tenant.id, (q) => repo.findUserByWorkEmail(q, tenant.id, claims.email))

    if (!user) {
      throw httpError.forbidden(
        `SSO authentication succeeded but no account exists for ${claims.email} in this tenant. ` +
        'Contact your administrator to create an account before using SSO.',
      )
    }

    if (user.status !== 'active') {
      throw httpError.forbidden('Account is not active. Contact your administrator.')
    }

    const token = fastify.jwt.sign(
      {
        sub: user.userId,
        tenant: tenant.id,
        employeeId: user.employeeId,
        roles: user.roles,
        permissions: user.permissions,
      },
      { expiresIn: config.jwtExpires },
    )

    await db.tenant(tenant.id, async (q) => {
      await q.exec(`UPDATE user_accounts SET last_login_at = now() WHERE id = $1`, [user.userId])
    })

    const accessTtlSeconds = 900
    return {
      accessToken: token,
      refreshToken: 'sso-session',
      expiresIn: accessTtlSeconds,
    }
  })
}
