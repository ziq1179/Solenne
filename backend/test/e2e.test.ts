import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Db } from '../src/db/index.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig, loadEnvFile } from '../src/config.js'
import { resetDemoLeaveState, seedDatabase, SEED } from '../src/seed/seed.js'

loadEnvFile()

let db: Db
let app: FastifyInstance

async function login(subdomain: string, email: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password, tenantSubdomain: subdomain },
  })
  return res.json()
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

let admin: string
let priya: string
let aisha: string
let globexAdmin: string

beforeAll(async () => {
  const config = loadConfig()
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required to run the suite — see .env.example')
  }
  db = await Db.open({
    connectionString: config.databaseUrl,
    max: config.dbPoolSize,
    ssl: config.dbSsl,
  })
  await seedDatabase(db)
  // The suite mutates leave data (submit/approve). Re-running it must start
  // from clean balances, otherwise the "remaining 14.5" assertions drift.
  await resetDemoLeaveState(db)
  app = await buildApp({ db, config, logger: false })
  await app.ready()

  admin = (await login('acme', 'admin@acme.com', 'admin123')).accessToken
  priya = (await login('acme', 'priya@acme.com', 'manager123')).accessToken
  aisha = (await login('acme', 'aisha@acme.com', 'employee123')).accessToken
  globexAdmin = (await login('globex', 'admin@globex.com', 'admin123')).accessToken
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.close()
})

describe('auth', () => {
  it('rejects unknown tenants, bad passwords, and returns tokens on success', async () => {
    const noTenant = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@acme.com', password: 'admin123', tenantSubdomain: 'nope' },
    })
    expect(noTenant.statusCode).toBe(401)

    const badPass = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@acme.com', password: 'wrong', tenantSubdomain: 'acme' },
    })
    expect(badPass.statusCode).toBe(401)

    const good = await login('acme', 'admin@acme.com', 'admin123')
    expect(good.accessToken).toBeTruthy()
    expect(good.refreshToken).toBeTruthy()
    expect(good.expiresIn).toBeGreaterThan(0)

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(good.accessToken) })
    expect(me.statusCode).toBe(200)
    const meBody = me.json()
    expect(meBody.roles).toContain('admin')
    expect(meBody.permissions).toContain('employee:write')
    expect(meBody.permissions).toContain('audit:read')
  })

  it('refreshes access tokens and rotates the refresh token', async () => {
    const loginRes = await login('acme', 'admin@acme.com', 'admin123')
    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: loginRes.refreshToken },
    })
    expect(refreshed.statusCode).toBe(200)
    const body = refreshed.json()
    expect(body.accessToken).toBeTruthy()
    expect(body.refreshToken).not.toBe(loginRes.refreshToken)

    const replay = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: loginRes.refreshToken },
    })
    expect(replay.statusCode).toBe(401)
  })

  it('denies unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' })
    expect(res.statusCode).toBe(401)
  })
})

describe('core hr (employees)', () => {
  let createdId: string

  it('creates an employee with an idempotency key and replays the response', async () => {
    const key = '00000000-0000-4000-8000-0000000000aa'
    const payload = {
      firstName: 'Zara',
      lastName: 'Hussain',
      hireDate: '2026-09-01',
      employmentType: 'full_time',
      workEmail: 'zara@acme.com',
      departmentId: SEED.DEPT_ENG,
      managerEmployeeId: SEED.EMP_PRIYA,
      jobTitle: 'Backend Engineer',
    }

    const first = await app.inject({
      method: 'POST',
      url: '/employees',
      headers: { ...auth(admin), 'idempotency-key': key },
      payload,
    })
    expect(first.statusCode).toBe(201)
    createdId = first.json().id

    const replay = await app.inject({
      method: 'POST',
      url: '/employees',
      headers: { ...auth(admin), 'idempotency-key': key },
      payload,
    })
    expect(replay.statusCode).toBe(201)
    expect(replay.json().id).toBe(createdId)

    const conflicting = await app.inject({
      method: 'POST',
      url: '/employees',
      headers: { ...auth(admin), 'idempotency-key': key },
      payload: { ...payload, firstName: 'Different' },
    })
    expect(conflicting.statusCode).toBe(409)
  })

  it('lists employees; scopes to self for a non-directory role', async () => {
    const asAdmin = await app.inject({ method: 'GET', url: '/employees', headers: auth(admin) })
    expect(asAdmin.statusCode).toBe(200)
    expect(asAdmin.json().total).toBeGreaterThanOrEqual(createdId ? 5 : 4)

    const asAisha = await app.inject({ method: 'GET', url: '/employees', headers: auth(aisha) })
    expect(asAisha.statusCode).toBe(200)
    expect(asAisha.json().data.length).toBe(1)
    expect(asAisha.json().data[0].email ?? '').toBe('')
    expect(asAisha.json().data[0].firstName).toBe('Aisha')
  })

  it('isolates tenants: Globex cannot see or touch Acme employees', async () => {
    const globexList = await app.inject({ method: 'GET', url: '/employees', headers: auth(globexAdmin) })
    expect(globexList.statusCode).toBe(200)
    expect(globexList.json().data.length).toBe(1)

    const peek = await app.inject({ method: 'GET', url: `/employees/${SEED.EMP_AISHA}`, headers: auth(globexAdmin) })
    expect(peek.statusCode).toBe(404)
  })

  it('keeps responses tenant-pure under concurrent cross-tenant load (Promise.all)', async () => {
    const acmeIds: string[] = [SEED.EMP_ADMIN, SEED.EMP_PRIYA, SEED.EMP_AISHA]
    const globexId: string = SEED.EMP_GLOBEX

    // Fire two tenants' worth of list requests at the same time. With a
    // session-level SET, request B's SET could land between request A's
    // SET and its query, and A would read B's rows. Each request here runs
    // inside its own BEGIN… SET LOCAL … COMMIT block, so every response must
    // contain only its own tenant's rows.
    const requests = [
      ...Array.from({ length: 6 }, () => app.inject({ method: 'GET', url: '/employees', headers: auth(admin) })),
      ...Array.from({ length: 6 }, () => app.inject({ method: 'GET', url: '/employees', headers: auth(globexAdmin) })),
    ]
    const responses = await Promise.all(requests)

    responses.forEach((res) => expect(res.statusCode).toBe(200))

    const acmeBodies = responses.filter((_, i) => i < 6).map((r) => r.json().data)
    const globexBodies = responses.filter((_, i) => i >= 6).map((r) => r.json().data)

    for (const acmeData of acmeBodies) {
      const ids = acmeData.map((e: { id: string }) => e.id)
      expect(ids).toEqual(expect.arrayContaining(acmeIds))
      expect(ids).not.toContain(globexId)
    }
    for (const globexData of globexBodies) {
      const ids = globexData.map((e: { id: string }) => e.id)
      expect(ids).toHaveLength(1)
      expect(ids[0]).toBe(globexId)
      expect(ids.some((id: string) => acmeIds.includes(id))).toBe(false)
    }
  })

  it('keeps an employment_history trail when job title changes', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/employees/${SEED.EMP_AISHA}`,
      headers: { ...auth(admin), 'idempotency-key': '00000000-0000-4000-8000-0000000000bb' },
      payload: { jobTitle: 'Principal Product Designer' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().jobTitle).toBe('Principal Product Designer')

    const audits = await app.inject({ method: 'GET', url: '/audit-logs', headers: auth(admin) })
    const actions = audits.json().data.map((l: { action: string }) => l.action)
    expect(actions).toContain('employee.hired')
    expect(actions).toContain('employee.updated')
  })

  it('offboards (soft-deletes) an employee', async () => {
    const make = await app.inject({
      method: 'POST',
      url: '/employees',
      headers: { ...auth(admin), 'idempotency-key': '00000000-0000-4000-8000-0000000000cc' },
      payload: { firstName: 'Temp', lastName: 'Worker', hireDate: '2026-09-01', employmentType: 'contractor' },
    })
    const id = make.json().id

    const del = await app.inject({ method: 'DELETE', url: `/employees/${id}`, headers: auth(admin) })
    expect(del.statusCode).toBe(204)

    const fetched = await app.inject({ method: 'GET', url: `/employees/${id}`, headers: auth(admin) })
    expect(fetched.json().employmentStatus).toBe('terminated')
    expect(fetched.json().terminationDate).toBeTruthy()
  })
})

describe('leave', () => {
  it('exposes configured leave types and Aisha balances', async () => {
    const types = await app.inject({ method: 'GET', url: '/leave-types', headers: auth(admin) })
    expect(types.statusCode).toBe(200)
    const names = types.json().map((t: { name: string }) => t.name)
    expect(names).toContain('Annual Leave')

    const balances = await app.inject({
      method: 'GET',
      url: `/employees/${SEED.EMP_AISHA}/leave-balances?year=2026`,
      headers: auth(admin),
    })
    const annual = balances.json().find((b: { leaveTypeId: string }) => b.leaveTypeId === SEED.LEAVE_ANNUAL)
    expect(annual.remainingDays).toBeCloseTo(14.5)
  })

  it('rejects leave requests that exceed the balance', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/leave-requests',
      headers: { ...auth(aisha), 'idempotency-key': '00000000-0000-4000-8000-0000000000dd' },
      payload: {
        leaveTypeId: SEED.LEAVE_ANNUAL,
        startDate: '2026-10-01',
        endDate: '2026-11-30',
      },
    })
    expect(res.statusCode).toBe(422)
  })

  it('submits, lists and approves a leave request end to end', async () => {
    const submit = await app.inject({
      method: 'POST',
      url: '/leave-requests',
      headers: { ...auth(aisha), 'idempotency-key': '00000000-0000-4000-8000-0000000000ee' },
      payload: {
        leaveTypeId: SEED.LEAVE_ANNUAL,
        startDate: '2026-09-21',
        endDate: '2026-09-22',
        reason: 'Family trip',
      },
    })
    expect(submit.statusCode).toBe(201)
    const request = submit.json()
    expect(request.status).toBe('pending')
    expect(request.daysRequested).toBe(2)

    const asPriaList = await app.inject({ method: 'GET', url: '/leave-requests', headers: auth(priya) })
    expect(asPriaList.json().data.length).toBeGreaterThanOrEqual(1)

    const aishaCannotApprove = await app.inject({
      method: 'POST',
      url: `/leave-requests/${request.id}/decision`,
      headers: { ...auth(aisha), 'idempotency-key': '00000000-0000-4000-8000-0000000000ef' },
      payload: { decision: 'approved' },
    })
    expect(aishaCannotApprove.statusCode).toBe(403)

    const approve = await app.inject({
      method: 'POST',
      url: `/leave-requests/${request.id}/decision`,
      headers: { ...auth(priya), 'idempotency-key': '00000000-0000-4000-8000-0000000000f0' },
      payload: { decision: 'approved', decisionNote: 'Enjoy!' },
    })
    expect(approve.statusCode).toBe(200)
    expect(approve.json().status).toBe('approved')

    const balances = await app.inject({
      method: 'GET',
      url: `/employees/${SEED.EMP_AISHA}/leave-balances?year=2026`,
      headers: auth(admin),
    })
    const annual = balances.json().find((b: { leaveTypeId: string }) => b.leaveTypeId === SEED.LEAVE_ANNUAL)
    expect(annual.usedDays).toBeCloseTo(11.5)
    expect(annual.remainingDays).toBeCloseTo(12.5)

    const doubleApprove = await app.inject({
      method: 'POST',
      url: `/leave-requests/${request.id}/decision`,
      headers: { ...auth(priya), 'idempotency-key': '00000000-0000-4000-8000-0000000000f1' },
      payload: { decision: 'approved' },
    })
    expect(doubleApprove.statusCode).toBe(409)
  })

  it('scopes leave request lists to the requester for self-service', async () => {
    const own = await app.inject({ method: 'GET', url: '/leave-requests', headers: auth(aisha) })
    expect(own.statusCode).toBe(200)
    expect(own.json().data.length).toBe(1)
  })
})