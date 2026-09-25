import { randomBytes } from 'node:crypto'

process.env.INTEGRATION_HUB_KEY = randomBytes(32).toString('base64')
process.env.CURRENT_KEY_VERSION = '1'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Db } from '../src/db/index.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig, loadEnvFile } from '../src/config.js'
import { resetDemoLeaveState, seedDatabase, SEED } from '../src/seed/seed.js'
import { warmUpDb } from './warmup.js'

// Mock exchangeCode at the module level — this is the ONLY thing we mock.
// buildAuthorizeUrl and randomState are also stubbed because they're in the
// same module, but they're never called by the callback handler under test.
// Everything downstream of exchangeCode in sso.routes.ts (domain check,
// user lookup by employees.work_email, JWT signing, last_login_at touch)
// runs against real Postgres with real RLS.
const { mockExchangeCode } = vi.hoisted(() => ({
  mockExchangeCode: vi.fn(),
}))

vi.mock('../src/modules/sso/oidc-provider.js', () => ({
  buildAuthorizeUrl: vi.fn(() => 'https://mock-idp.example.com/authorize'),
  exchangeCode: mockExchangeCode,
  randomState: vi.fn(() => 'mock-state-value'),
}))

loadEnvFile()

const TENANT_ID = SEED.TENANT_ACME

let db: Db
let app: FastifyInstance

async function login(subdomain: string, email: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password, tenantSubdomain: subdomain },
  })
  return { status: res.statusCode, body: res.json() as Record<string, any> }
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

let adminToken: string

beforeAll(async () => {
  const config = loadConfig()
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required to run the suite — see .env.example')
  }
  await warmUpDb(config.databaseUrl)
  db = await Db.open({
    connectionString: config.databaseUrl,
    max: config.dbPoolSize,
    ssl: config.dbSsl,
  })
  await seedDatabase(db)
  await resetDemoLeaveState(db)
  app = await buildApp({ db, config, logger: false })
  await app.ready()

  const adminLogin = await login('acme', 'admin@acme.com', 'admin123')
  adminToken = adminLogin.body.accessToken
})

afterAll(async () => {
  if (db) {
    await db.system(async (q) => {
      await q.exec(`UPDATE tenants SET sso_config_json = NULL WHERE id = $1`, [TENANT_ID])
      await q.exec(`DELETE FROM integration_connections WHERE provider = 'sso_client_secret' AND tenant_id = $1`, [TENANT_ID])
    })
  }
  if (app) await app.close()
  if (db) await db.close()
})

function errMsg(res: { json(): Record<string, any> }): string {
  const body = res.json()
  if (typeof body.error === 'string') return body.error
  if (body.error?.message) return body.error.message
  return JSON.stringify(body.error ?? body)
}

// ─── SSO config endpoints ─────────────────────────────────────────────────────

describe('SSO config — GET returns disabled when no config', () => {
  it('GET /tenants/:id/sso returns enabled: false when no config', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.enabled).toBe(false)
  })
})

describe('SSO config — PATCH enable/configure', () => {
  it('admin can configure SSO', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
      payload: {
        discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret-value',
        scopes: ['openid', 'email', 'profile'],
        allowedEmailDomains: ['acme.com'],
        defaultRole: 'employee',
        enforceSso: false,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.enabled).toBe(true)
    expect(body.provider).toBe('oidc')
    expect(body.discoveryUrl).toBe('https://accounts.google.com/.well-known/openid-configuration')
    expect(body.clientId).toBe('test-client-id')
    expect(body.allowedEmailDomains).toEqual(['acme.com'])
    expect(body.clientSecretConfigured).toBe(true)
  })

  it('client secret never appears in GET response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.clientSecret).toBeUndefined()
    expect(body.clientSecretConfigured).toBe(true)

    const raw = res.rawPayload.toString()
    expect(raw).not.toContain('test-client-secret-value')
    expect(raw).not.toContain('credential_enc')
  })

  it('client secret is encrypted in integration_connections', async () => {
    const { rows } = await db.system(async (q) => {
      return q.query<{ credentialEnc: string; maskedPreview: string }>(
        `SELECT credential_enc AS "credentialEnc", masked_preview AS "maskedPreview"
         FROM integration_connections
         WHERE tenant_id = $1 AND provider = 'sso_client_secret'`,
        [TENANT_ID],
      )
    })
    expect(rows.length).toBe(1)
    expect(rows[0]!.credentialEnc).not.toContain('test-client-secret-value')
    expect(rows[0]!.maskedPreview).toContain('****')
  })
})

describe('SSO config — enforceSso lockout guard', () => {
  it('rejects enforceSso: true when no admin has a work_email', async () => {
    await db.system(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `SELECT e.id FROM employees e
         JOIN user_accounts u ON u.id = e.user_account_id
         WHERE u.tenant_id = $1 AND u.email = 'admin@acme.com'`,
        [TENANT_ID],
      )
      if (rows[0]) {
        await q.exec(`UPDATE employees SET work_email = NULL WHERE id = $1`, [rows[0].id])
      }
    })

    const res = await app.inject({
      method: 'PATCH',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
      payload: {
        discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret-value',
        enforceSso: true,
      },
    })
    expect(res.statusCode).toBe(400)
    expect(errMsg(res)).toContain('Cannot enforce SSO')

    await db.system(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `SELECT e.id FROM employees e
         JOIN user_accounts u ON u.id = e.user_account_id
         WHERE u.tenant_id = $1 AND u.email = 'admin@acme.com'`,
        [TENANT_ID],
      )
      if (rows[0]) {
        await q.exec(`UPDATE employees SET work_email = 'admin@acme.com' WHERE id = $1`, [rows[0].id])
      }
    })
  })

  it('allows enforceSso: true when admin has a work_email', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
      payload: {
        discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret-value',
        enforceSso: true,
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().enforceSso).toBe(true)
  })
})

describe('enforceSso blocks password login', () => {
  it('password login is rejected when enforceSso is true', async () => {
    const res = await login('acme', 'admin@acme.com', 'admin123')
    expect(res.status).toBe(403)
    expect(typeof res.body.error === 'string' ? res.body.error : res.body.error?.message).toContain('Password login is disabled')
  })

  it('password login rejected for manager too when enforceSso is true', async () => {
    const res = await login('acme', 'priya@acme.com', 'manager123')
    expect(res.status).toBe(403)
    expect(typeof res.body.error === 'string' ? res.body.error : res.body.error?.message).toContain('Password login is disabled')
  })
})

describe('enforceSso — disable SSO restores password login', () => {
  it('after DELETE SSO config, password login works again', async () => {
    const disableRes = await app.inject({
      method: 'DELETE',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
    })
    expect(disableRes.statusCode).toBe(200)

    const loginRes = await login('acme', 'admin@acme.com', 'admin123')
    expect(loginRes.status).toBe(200)
    expect(loginRes.body.accessToken).toBeDefined()
  })
})

describe('SSO config — manager and employee cannot access', () => {
  let managerToken: string
  let employeeToken: string

  beforeAll(async () => {
    const managerLogin = await login('acme', 'priya@acme.com', 'manager123')
    managerToken = managerLogin.body.accessToken
    const employeeLogin = await login('acme', 'aisha@acme.com', 'employee123')
    employeeToken = employeeLogin.body.accessToken
  })

  const endpoints = [
    { method: 'GET' as const, url: `/tenants/${TENANT_ID}/sso` },
    { method: 'PATCH' as const, url: `/tenants/${TENANT_ID}/sso` },
    { method: 'DELETE' as const, url: `/tenants/${TENANT_ID}/sso` },
  ]

  for (const { method, url } of endpoints) {
    it(`manager → ${method} ${url} returns 403`, async () => {
      const res = await app.inject({
        method,
        url,
        headers: auth(managerToken),
        ...(method === 'PATCH' ? { payload: { clientId: 'x', clientSecret: 'x', discoveryUrl: 'https://example.com/.well-known/openid-configuration' } } : {}),
      })
      expect(res.statusCode).toBe(403)
    })

    it(`employee → ${method} ${url} returns 403`, async () => {
      const res = await app.inject({
        method,
        url,
        headers: auth(employeeToken),
        ...(method === 'PATCH' ? { payload: { clientId: 'x', clientSecret: 'x', discoveryUrl: 'https://example.com/.well-known/openid-configuration' } } : {}),
      })
      expect(res.statusCode).toBe(403)
    })
  }
})

describe('SSO CSRF state validation', () => {
  it('callback with missing state returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sso/callback',
      payload: { code: 'test-code', state: 'wrong-state' },
    })
    expect(res.statusCode).toBe(400)
    expect(errMsg(res)).toContain('Missing SSO session cookies')
  })

  it('callback with mismatched state returns 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sso/callback',
      payload: { code: 'test-code', state: 'mismatched-state-value' },
      cookies: {
        sso_state: 'correct-state-value',
        sso_tenant: 'acme',
      },
    })
    expect(res.statusCode).toBe(403)
    expect(errMsg(res)).toContain('CSRF state mismatch')
  })
})

describe('SSO login — tenant not configured', () => {
  it('GET /auth/sso/login with unknown tenant returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/sso/login?tenant=nonexistent',
    })
    expect(res.statusCode).toBe(400)
    expect(errMsg(res)).toContain('SSO is not configured')
  })

  it('POST /auth/sso/callback with unknown tenant returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sso/callback',
      payload: { code: 'test', state: 'test' },
      cookies: {
        sso_state: 'test',
        sso_tenant: 'nonexistent',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(errMsg(res)).toContain('SSO is not configured')
  })
})

describe('SSO — PATCH validation errors', () => {
  it('missing required fields returns 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
      payload: { clientId: 'test' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('invalid discoveryUrl returns 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
      payload: {
        discoveryUrl: 'not-a-url',
        clientId: 'test',
        clientSecret: 'test',
      },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('SSO — DELETE when not configured', () => {
  it('DELETE on tenant with no SSO config returns disabled: true', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
      payload: {
        discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret-value',
      },
    })
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
    })
    expect(deleteRes.statusCode).toBe(200)

    const deleteRes2 = await app.inject({
      method: 'DELETE',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
    })
    expect(deleteRes2.statusCode).toBe(200)
    expect(deleteRes2.json().message).toContain('SSO was not configured')
  })
})

describe('TENANT_READ and TENANT_WRITE permissions', () => {
  it('admin role includes TENANT_READ and TENANT_WRITE', async () => {
    const { SYSTEM_ROLES } = await import('../src/modules/permissions.js')
    const adminPerms = SYSTEM_ROLES.admin.permissions
    expect(adminPerms).toContain('tenant:read')
    expect(adminPerms).toContain('tenant:write')
  })

  it('hr_manager role does NOT include TENANT_READ or TENANT_WRITE', async () => {
    const { SYSTEM_ROLES } = await import('../src/modules/permissions.js')
    const hrPerms = SYSTEM_ROLES.hr_manager.permissions
    expect(hrPerms).not.toContain('tenant:read')
    expect(hrPerms).not.toContain('tenant:write')
  })

  it('manager role does NOT include TENANT_READ or TENANT_WRITE', async () => {
    const { SYSTEM_ROLES } = await import('../src/modules/permissions.js')
    const mgrPerms = SYSTEM_ROLES.manager.permissions
    expect(mgrPerms).not.toContain('tenant:read')
    expect(mgrPerms).not.toContain('tenant:write')
  })

  it('employee role does NOT include TENANT_READ or TENANT_WRITE', async () => {
    const { SYSTEM_ROLES } = await import('../src/modules/permissions.js')
    const empPerms = SYSTEM_ROLES.employee.permissions
    expect(empPerms).not.toContain('tenant:read')
    expect(empPerms).not.toContain('tenant:write')
  })
})

// ─── SSO callback — OIDC exchange boundary (mocked exchangeCode) ──────────────
//
// The mock replaces only exchangeCode(). Everything else in the callback
// handler is real: CSRF state validation, tenant lookup, domain allowlist
// check, user lookup by employees.work_email, JWT signing with correct
// roles/permissions, last_login_at touch. All against real Postgres.

describe('SSO callback — OIDC exchange boundary (mocked exchangeCode)', () => {
  beforeAll(async () => {
    // Ensure SSO is configured with allowedEmailDomains: ['acme.com'] and a client secret
    await app.inject({
      method: 'PATCH',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
      payload: {
        discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret-value',
        allowedEmailDomains: ['acme.com'],
        enforceSso: false,
      },
    })
    mockExchangeCode.mockReset()
  })

  afterAll(async () => {
    // Clean up SSO config
    await app.inject({
      method: 'DELETE',
      url: `/tenants/${TENANT_ID}/sso`,
      headers: auth(adminToken),
    })
    mockExchangeCode.mockReset()
  })

  it('domain allowlist rejection — IdP claims email outside allowedEmailDomains → 403, no user lookup attempted', async () => {
    mockExchangeCode.mockReset()
    // exchangeCode returns an email from a domain NOT in allowedEmailDomains
    mockExchangeCode.mockResolvedValueOnce({ email: 'hacker@evil.com' })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/sso/callback',
      payload: { code: 'fake-code', state: 'mock-state-value' },
      cookies: {
        sso_state: 'mock-state-value',
        sso_tenant: 'acme',
      },
    })

    expect(res.statusCode).toBe(403)
    expect(errMsg(res)).toContain('not authorized for SSO')
    expect(errMsg(res)).toContain('evil.com')

    // Confirm exchangeCode was called (the mock was exercised)
    expect(mockExchangeCode).toHaveBeenCalledTimes(1)
    expect(mockExchangeCode).toHaveBeenCalledWith(
      'fake-code',
      expect.objectContaining({ clientId: 'test-client-id' }),
      expect.stringContaining('/auth/sso/callback'),
      'mock-state-value',
    )
  })

  it('no-existing-account — valid IdP auth, domain allowed, but no matching employees.work_email → 403, no account created', async () => {
    mockExchangeCode.mockReset()
    // exchangeCode returns an email from the allowed domain, but no employee has this work_email
    mockExchangeCode.mockResolvedValueOnce({ email: 'ghost@acme.com' })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/sso/callback',
      payload: { code: 'fake-code', state: 'mock-state-value' },
      cookies: {
        sso_state: 'mock-state-value',
        sso_tenant: 'acme',
      },
    })

    expect(res.statusCode).toBe(403)
    expect(errMsg(res)).toContain('no account exists')
    expect(errMsg(res)).toContain('ghost@acme.com')

    // Confirm exchangeCode was called and the mock was exercised
    expect(mockExchangeCode).toHaveBeenCalledTimes(1)

    // Confirm no user_accounts row was created for this email
    const { rows } = await db.system(async (q) => {
      return q.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM user_accounts
         WHERE lower(email) = lower('ghost@acme.com')`,
      )
    })
    expect(rows[0]!.cnt).toBe('0')
  })

  it('successful login — valid IdP auth, domain allowed, matching employee → JWT issued with correct roles/permissions', async () => {
    mockExchangeCode.mockReset()
    // exchangeCode returns the admin's email (exists in seed data with work_email)
    mockExchangeCode.mockResolvedValueOnce({ email: 'admin@acme.com' })

    const res = await app.inject({
      method: 'POST',
      url: '/auth/sso/callback',
      payload: { code: 'fake-code', state: 'mock-state-value' },
      cookies: {
        sso_state: 'mock-state-value',
        sso_tenant: 'acme',
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.accessToken).toBeDefined()
    expect(typeof body.accessToken).toBe('string')
    expect(body.refreshToken).toBe('sso-session')
    expect(body.expiresIn).toBe(900)

    // Verify the JWT is valid and contains correct claims by calling /auth/me
    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    })
    expect(meRes.statusCode).toBe(200)
    const me = meRes.json()
    expect(me.email).toBe('admin@acme.com')
    expect(me.roles).toContain('admin')
    expect(me.permissions).toContain('tenant:read')
    expect(me.permissions).toContain('tenant:write')
    expect(me.permissions).toContain('employee:read')

    // Confirm exchangeCode was called with the right arguments
    expect(mockExchangeCode).toHaveBeenCalledTimes(1)
  })
})
