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

describe('attendance', () => {
  it('clocks in once, rejects a second clock-in, then clocks out', async () => {
    const clockIn = await app.inject({
      method: 'POST',
      url: '/attendance/clock-in',
      headers: { ...auth(aisha), 'idempotency-key': '00000000-0000-4000-8000-0000000000f2' },
      payload: { source: 'web' },
    })
    expect(clockIn.statusCode).toBe(201)
    const rec = clockIn.json()
    expect(rec.employeeId).toBe(SEED.EMP_AISHA)
    expect(rec.clockInAt).toBeTruthy()
    expect(rec.clockOutAt).toBeNull()
    expect(rec.totalMinutes).toBeNull()

    const dup = await app.inject({
      method: 'POST',
      url: '/attendance/clock-in',
      headers: { ...auth(aisha), 'idempotency-key': '00000000-0000-4000-8000-0000000000f3' },
      payload: { source: 'mobile', geo: { lat: 31.5, lng: 74.3 } },
    })
    expect(dup.statusCode).toBe(409)

    const clockOut = await app.inject({
      method: 'POST',
      url: '/attendance/clock-out',
      headers: { ...auth(aisha), 'idempotency-key': '00000000-0000-4000-8000-0000000000f4' },
    })
    expect(clockOut.statusCode).toBe(200)
    const closed = clockOut.json()
    expect(closed.id).toBe(rec.id)
    expect(closed.clockOutAt).toBeTruthy()
    expect(closed.totalMinutes).toBeGreaterThanOrEqual(0)

    const noOpen = await app.inject({
      method: 'POST',
      url: '/attendance/clock-out',
      headers: { ...auth(aisha), 'idempotency-key': '00000000-0000-4000-8000-0000000000f5' },
    })
    expect(noOpen.statusCode).toBe(404)
  })

  it('replays a clock-in idempotency key without a second record', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/attendance/clock-in',
      headers: { ...auth(admin), 'idempotency-key': '00000000-0000-4000-8000-0000000000f6' },
      payload: { source: 'biometric' },
    })
    expect(first.statusCode).toBe(201)

    const replay = await app.inject({
      method: 'POST',
      url: '/attendance/clock-in',
      headers: { ...auth(admin), 'idempotency-key': '00000000-0000-4000-8000-0000000000f6' },
      payload: { source: 'biometric' },
    })
    expect(replay.statusCode).toBe(201)
    expect(replay.json().id).toBe(first.json().id)
  })

  it('scopes attendance reads: self, directory, and cross-tenant', async () => {
    const own = await app.inject({
      method: 'GET',
      url: `/employees/${SEED.EMP_AISHA}/attendance`,
      headers: auth(aisha),
    })
    expect(own.statusCode).toBe(200)
    expect(own.json().length).toBeGreaterThanOrEqual(1)
    expect(own.json().every((r: { employeeId: string }) => r.employeeId === SEED.EMP_AISHA)).toBe(true)

    const otherEmployee = await app.inject({
      method: 'GET',
      url: `/employees/${SEED.EMP_PRIYA}/attendance`,
      headers: auth(aisha),
    })
    expect(otherEmployee.statusCode).toBe(404)

    const asManager = await app.inject({
      method: 'GET',
      url: `/employees/${SEED.EMP_AISHA}/attendance`,
      headers: auth(priya),
    })
    expect(asManager.statusCode).toBe(200)

    const crossTenant = await app.inject({
      method: 'GET',
      url: `/employees/${SEED.EMP_AISHA}/attendance`,
      headers: auth(globexAdmin),
    })
    expect(crossTenant.statusCode).toBe(404)

    const fromTo = await app.inject({
      method: 'GET',
      url: `/employees/${SEED.EMP_AISHA}/attendance?from=2020-01-01&to=2999-01-01`,
      headers: auth(admin),
    })
    expect(fromTo.statusCode).toBe(200)
    expect(fromTo.json().length).toBeGreaterThanOrEqual(1)

    const anon = await app.inject({ method: 'GET', url: `/employees/${SEED.EMP_AISHA}/attendance` })
    expect(anon.statusCode).toBe(401)
  })
})

describe('reports', () => {
  it('headcount: aggregates by department/location/type, excludes terminated, stays tenant-pure', async () => {
    const acme = await app.inject({ method: 'GET', url: '/reports/headcount', headers: auth(admin) })
    expect(acme.statusCode).toBe(200)
    const body = acme.json()
    // Seeded trio + Marcus + the employee the employees suite creates (Zara).
    expect(body.total).toBe(5)
    expect(body.byDepartment.reduce((s: number, d: { count: number }) => s + d.count, 0)).toBe(body.total)
    expect(body.byLocation.reduce((s: number, l: { count: number }) => s + l.count, 0)).toBe(body.total)
    expect(body.byEmploymentType.reduce((s: number, t: { count: number }) => s + t.count, 0)).toBe(body.total)

    const design = body.byDepartment.find((d: { id: string }) => d.id === SEED.DEPT_DESIGN)
    expect(design?.count).toBe(3)
    const lhr = body.byLocation.find((l: { id: string }) => l.id === SEED.LOC_LHR)
    expect(lhr?.count).toBe(3)

    // The offboards test terminated Temp Worker: it must not appear as active.
    const terminated = await app.inject({
      method: 'GET',
      url: '/reports/headcount?status=terminated',
      headers: auth(admin),
    })
    expect(terminated.statusCode).toBe(200)
    expect(terminated.json().total).toBe(1)

    // Cross-tenant isolation: globex only ever sees its own rows.
    const globex = await app.inject({ method: 'GET', url: '/reports/headcount', headers: auth(globexAdmin) })
    expect(globex.json().total).toBe(1)
  })

  it('denies reporting to a self-service employee', async () => {
    const res = await app.inject({ method: 'GET', url: '/reports/headcount', headers: auth(aisha) })
    expect(res.statusCode).toBe(403)
    const anon = await app.inject({ method: 'GET', url: '/reports/headcount' })
    expect(anon.statusCode).toBe(401)
  })

  it('attendance-summary: aggregates clock-ins and minutes in range', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reports/attendance-summary?from=2020-01-01&to=2999-01-01',
      headers: auth(admin),
    })
    expect(res.statusCode).toBe(200)
    const summary = res.json()
    expect(summary.rows.length).toBeGreaterThanOrEqual(1)
    expect(summary.totalClockIns).toBeGreaterThanOrEqual(2)

    const aishaRow = summary.rows.find((r: { employeeId: string }) => r.employeeId === SEED.EMP_AISHA)
    expect(aishaRow).toBeTruthy()
    expect(aishaRow.clockIns).toBeGreaterThanOrEqual(1)
    expect(aishaRow.totalMinutes).toBeGreaterThanOrEqual(0)

    // Admin left an open record in the attendance idempotency-replay test.
    const adminRow = summary.rows.find((r: { employeeId: string }) => r.employeeId === SEED.EMP_ADMIN)
    expect(adminRow).toBeTruthy()

    const badRange = await app.inject({
      method: 'GET',
      url: '/reports/attendance-summary?from=2999-01-01&to=2020-01-01',
      headers: auth(admin),
    })
    expect(badRange.statusCode).toBe(400)
  })

  it('leave-summary: reflects balances already mutated by the leave suite', async () => {
    const res = await app.inject({ method: 'GET', url: '/reports/leave-summary?year=2026', headers: auth(admin) })
    expect(res.statusCode).toBe(200)

    const aishaRow = res.json().find((r: { employeeId: string }) => r.employeeId === SEED.EMP_AISHA)
    const annual = aishaRow.balances.find((b: { leaveTypeId: string }) => b.leaveTypeId === SEED.LEAVE_ANNUAL)
    expect(annual.accruedDays).toBeCloseTo(24)
    expect(annual.usedDays).toBeCloseTo(11.5) // 9.5 seeded + 2 approved by the leave suite
    expect(annual.remainingDays).toBeCloseTo(12.5)

    const globex = await app.inject({
      method: 'GET',
      url: '/reports/leave-summary?year=2026',
      headers: auth(globexAdmin),
    })
    expect(globex.json().map((r: { employeeId: string }) => r.employeeId)).toEqual([SEED.EMP_GLOBEX])
  })
})

describe('tenant self-service signup', () => {
  // Timestamp-baked so the suite can be re-run safely; a fixed subdomain would
  // 409 on the second run.
  const subdomain = `t${Date.now().toString(36)}`
  const email = `admin@${subdomain}.com`
  const password = 'password123'
  let signup: { accessToken: string; refreshToken: string; expiresIn: number }

  it('provisions a tenant, seeds defaults, and auto-logs-in the admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/signup',
      payload: {
        companyName: 'Test Company',
        subdomain,
        adminEmail: email,
        adminPassword: password,
        adminFirstName: 'Test',
        adminLastName: 'Admin',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.accessToken).toBeTruthy()
    expect(body.refreshToken).toBeTruthy()
    expect(body.expiresIn).toBeGreaterThan(0)
    expect(body.tenant).toMatchObject({ subdomain, plan: 'trial' })
    signup = body

    // The freshly-minted JWT carries seeded admin claims.
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(body.accessToken) })
    expect(me.statusCode).toBe(200)
    const meBody = me.json()
    expect(meBody.roles).toEqual(expect.arrayContaining(['admin', 'employee']))
    expect(meBody.permissions).toContain('employee:write')
  })

  it('seeds the admin employee and standard leave types; the same credentials log in', async () => {
    const employees = await app.inject({
      method: 'GET',
      url: '/employees',
      headers: auth(signup.accessToken),
    })
    expect(employees.statusCode).toBe(200)
    const list = employees.json()
    expect(list.total).toBe(1)
    expect(list.data[0].jobTitle).toBe('Administrator')

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password, tenantSubdomain: subdomain },
    })
    expect(login.statusCode).toBe(200)
  })

  it('rejects a taken subdomain with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/signup',
      payload: {
        companyName: 'Duplicate',
        subdomain,
        adminEmail: 'dup@example.com',
        adminPassword: password,
        adminFirstName: 'Dup',
        adminLastName: 'User',
      },
    })
    expect(res.statusCode).toBe(409)
  })

  it('rejects invalid payloads with 400', async () => {
    const badSub = await app.inject({
      method: 'POST',
      url: '/tenants/signup',
      payload: {
        companyName: 'X',
        subdomain: 'Not Valid!',
        adminEmail: email,
        adminPassword: password,
        adminFirstName: 'A',
        adminLastName: 'B',
      },
    })
    expect(badSub.statusCode).toBe(400)

    const weakPassword = await app.inject({
      method: 'POST',
      url: '/tenants/signup',
      payload: {
        companyName: 'X',
        subdomain: 'another-placeholder-sub',
        adminEmail: 'weak@example.com',
        adminPassword: 'short',
        adminFirstName: 'A',
        adminLastName: 'B',
      },
    })
    expect(weakPassword.statusCode).toBe(400)
  })
})

describe('recruiting (ats)', () => {
  it('lists seeded job openings; employees without ats:read are denied', async () => {
    const res = await app.inject({ method: 'GET', url: '/job-openings', headers: auth(admin) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    const titles = body.data.map((j: { title: string }) => j.title)
    expect(titles).toContain('Senior Product Designer')
    const designer = body.data.find((j: { id: string }) => j.id === SEED.JOB_DESIGNER)
    expect(designer.status).toBe('open')
    expect(designer.departmentName).toBe('Design')

    const denied = await app.inject({ method: 'GET', url: '/job-openings', headers: auth(aisha) })
    expect(denied.statusCode).toBe(403)
  })

  it('runs a requisition through draft → submit → approve → open → close', async () => {
    const key = '00000000-0000-4000-8000-0000000000ba'
    const created = await app.inject({
      method: 'POST',
      url: '/job-openings',
      headers: { ...auth(admin), 'Idempotency-Key': key },
      payload: {
        title: 'QA Engineer',
        departmentId: SEED.DEPT_ENG,
        locationId: SEED.LOC_LHR,
        employmentType: 'full_time',
        salaryMin: 30000,
        salaryMax: 45000,
        headcount: 2,
        status: 'draft',
      },
    })
    expect(created.statusCode).toBe(201)
    const job = created.json()
    expect(job.status).toBe('draft')
    expect(job.departmentName).toBe('Engineering')

    // Managers may raise requisitions but not approve them.
    const managerDenied = await app.inject({
      method: 'POST',
      url: `/job-openings/${job.id}/decision`,
      headers: auth(priya),
      payload: { decision: 'approved' },
    })
    expect(managerDenied.statusCode).toBe(403)

    const submitted = await app.inject({
      method: 'POST',
      url: `/job-openings/${job.id}/submit`,
      headers: auth(admin),
      payload: {},
    })
    expect(submitted.statusCode).toBe(200)
    expect(submitted.json().status).toBe('pending_approval')

    const approved = await app.inject({
      method: 'POST',
      url: `/job-openings/${job.id}/decision`,
      headers: auth(admin),
      payload: { decision: 'approved', note: 'Budget approved' },
    })
    expect(approved.statusCode).toBe(200)
    expect(approved.json().status).toBe('open')

    // An open opening can be put on hold then closed; a rejected draft cannot.
    const hold = await app.inject({
      method: 'POST',
      url: `/job-openings/${job.id}/decision`,
      headers: auth(admin),
      payload: { decision: 'on_hold' },
    })
    expect(hold.json().status).toBe('on_hold')
    const closed = await app.inject({
      method: 'POST',
      url: `/job-openings/${job.id}/decision`,
      headers: auth(admin),
      payload: { decision: 'closed' },
    })
    expect(closed.json().status).toBe('closed')

    // Cleanup so re-runs don't accumulate throwaway openings.
    const bye = await app.inject({
      method: 'DELETE',
      url: `/job-openings/${job.id}`,
      headers: auth(admin),
    })
    expect(bye.statusCode).toBe(204)
  })

  it('enforces the candidate pipeline workflow', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/job-openings/${SEED.JOB_DESIGNER}/candidates`,
      headers: auth(admin),
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().total).toBe(3)

    const offered = await app.inject({
      method: 'GET',
      url: `/job-openings/${SEED.JOB_DESIGNER}/candidates?stage=offer`,
      headers: auth(admin),
    })
    expect(offered.json().data.map((c: { id: string }) => c.id)).toEqual([SEED.CAND_OFFER])

    // screening → interview is fine; skipping straight to hired is not.
    const advance = await app.inject({
      method: 'POST',
      url: `/candidates/${SEED.CAND_RYO}/transition`,
      headers: auth(admin),
      payload: { stage: 'interview' },
    })
    expect(advance.statusCode).toBe(200)
    expect(advance.json().stage).toBe('interview')

    const prematureHire = await app.inject({
      method: 'POST',
      url: `/candidates/${SEED.CAND_RYO}/transition`,
      headers: auth(admin),
      payload: { stage: 'hired' },
    })
    expect(prematureHire.statusCode).toBe(409)

    // offer → hired works, and hired is terminal.
    const hire = await app.inject({
      method: 'POST',
      url: `/candidates/${SEED.CAND_OFFER}/transition`,
      headers: auth(admin),
      payload: { stage: 'hired' },
    })
    expect(hire.statusCode).toBe(200)
    expect(hire.json().stage).toBe('hired')
    const undoHire = await app.inject({
      method: 'POST',
      url: `/candidates/${SEED.CAND_OFFER}/transition`,
      headers: auth(admin),
      payload: { stage: 'applied' },
    })
    expect(undoHire.statusCode).toBe(409)

    // applied → rejected works, and rejected is terminal.
    const reject = await app.inject({
      method: 'POST',
      url: `/candidates/${SEED.CAND_LENA}/transition`,
      headers: auth(admin),
      payload: { stage: 'rejected' },
    })
    expect(reject.statusCode).toBe(200)
    const undoReject = await app.inject({
      method: 'POST',
      url: `/candidates/${SEED.CAND_LENA}/transition`,
      headers: auth(admin),
      payload: { stage: 'screening' },
    })
    expect(undoReject.statusCode).toBe(409)
  })

  it('creates, updates, and soft-deletes a candidate; cross-tenant stays isolated', async () => {
    const key = '00000000-0000-4000-8000-0000000000bc'
    const created = await app.inject({
      method: 'POST',
      url: `/job-openings/${SEED.JOB_DESIGNER}/candidates`,
      headers: { ...auth(admin), 'Idempotency-Key': key },
      payload: {
        firstName: 'Ava',
        lastName: 'Ross',
        email: 'ava.ross@example.com',
        source: 'referral',
        resumeText: 'Referral from Marcus Webb; 4 years design systems.',
        rating: 3,
      },
    })
    expect(created.statusCode).toBe(201)
    const candidate = created.json()
    expect(candidate.stage).toBe('sourced')
    expect(candidate.source).toBe('referral')

    const updated = await app.inject({
      method: 'PATCH',
      url: `/candidates/${candidate.id}`,
      headers: auth(admin),
      payload: { rating: 5, notes: 'Design lead material' },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().rating).toBe(5)

    // RLS: globex never sees acme candidates.
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/candidates/${candidate.id}`,
      headers: auth(globexAdmin),
    })
    expect(crossTenant.statusCode).toBe(404)

    const gone = await app.inject({
      method: 'DELETE',
      url: `/candidates/${candidate.id}`,
      headers: auth(admin),
    })
    expect(gone.statusCode).toBe(204)
    const fetchGone = await app.inject({
      method: 'GET',
      url: `/candidates/${candidate.id}`,
      headers: auth(admin),
    })
    expect(fetchGone.statusCode).toBe(404)
  })
})