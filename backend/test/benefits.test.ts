import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Db } from '../src/db/index.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig, loadEnvFile } from '../src/config.js'
import { resetDemoLeaveState, seedDatabase, SEED } from '../src/seed/seed.js'
import { warmUpDb } from './warmup.js'

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

  admin = (await login('acme', 'admin@acme.com', 'admin123')).accessToken
  priya = (await login('acme', 'priya@acme.com', 'manager123')).accessToken
  aisha = (await login('acme', 'aisha@acme.com', 'employee123')).accessToken
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.close()
})

// ─── Manager gets 403 on EVERY benefits endpoint ────────────────────────────

describe('benefits — manager zero access (exhaustive)', () => {
  const endpoints = [
    { method: 'GET', url: '/benefits/plans' },
    { method: 'POST', url: '/benefits/plans', payload: { name: 'Test', planType: 'medical', coverageTiers: ['employee_only'], employeeCost: { employee_only: 100 } } },
    { method: 'PATCH', url: '/benefits/plans/00000000-0000-0000-0000-000000000000', payload: { name: 'X' } },
    { method: 'GET', url: '/benefits/periods' },
    { method: 'POST', url: '/benefits/periods', payload: { name: 'Test', startsAt: '2026-01-01', endsAt: '2026-01-31' } },
    { method: 'POST', url: `/benefits/periods/${SEED.BEN_PERIOD_OPEN}/status`, payload: { status: 'closed' } },
    { method: 'GET', url: '/benefits/enrollments' },
    { method: 'POST', url: '/benefits/enrollments', payload: { enrollmentPeriodId: SEED.BEN_PERIOD_OPEN, benefitPlanId: SEED.BEN_PLAN_MEDICAL, coverageTier: 'employee_only', employeePremium: 250, employerPremium: 250 } },
    { method: 'POST', url: `/benefits/enrollments/${SEED.BEN_ENROLLMENT_AISHA}/submit` },
    { method: 'POST', url: `/benefits/enrollments/${SEED.BEN_ENROLLMENT_AISHA}/confirm` },
    { method: 'POST', url: `/benefits/enrollments/${SEED.BEN_ENROLLMENT_AISHA}/withdraw` },
    { method: 'GET', url: '/benefits/dependents' },
    { method: 'POST', url: '/benefits/dependents', payload: { firstName: 'Test', lastName: 'Dep', relationship: 'child' } },
    { method: 'PATCH', url: `/benefits/dependents/${SEED.BEN_DEPENDENT_AISHA_SPOUSE}`, payload: { firstName: 'Changed' } },
    { method: 'POST', url: `/benefits/dependents/${SEED.BEN_DEPENDENT_AISHA_SPOUSE}/deactivate` },
    { method: 'GET', url: '/benefits/life-events' },
    { method: 'POST', url: '/benefits/life-events', payload: { eventType: 'marriage', eventDate: '2026-09-01' } },
    { method: 'POST', url: `/benefits/life-events/${SEED.BEN_LIFE_EVENT_AISHA}/acknowledge` },
  ]

  for (const { method, url, payload } of endpoints) {
    it(`manager → ${method} ${url} returns 403`, async () => {
      const res = await app.inject({
        method: method as any,
        url,
        headers: auth(priya),
        ...(payload ? { payload } : {}),
      })
      expect(res.statusCode).toBe(403)
      const body = res.json()
      expect(body.error).toBeDefined()
    })
  }
})

// ─── Admin/hr_manager can access benefits endpoints ──────────────────────────

describe('benefits — admin access', () => {
  it('admin can list benefit plans', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/benefits/plans',
      headers: auth(admin),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(2)
  })

  it('admin can list enrollment periods', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/benefits/periods',
      headers: auth(admin),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(2)
  })

  it('admin can list enrollments', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/benefits/enrollments',
      headers: auth(admin),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toBeDefined()
    expect(body.data.length).toBeGreaterThanOrEqual(1)
  })

  it('admin can list dependents', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/benefits/dependents',
      headers: auth(admin),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
  })

  it('admin can list life events', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/benefits/life-events',
      headers: auth(admin),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
  })
})

// ─── Employee scoping: only own data ────────────────────────────────────────

describe('benefits — employee scoping', () => {
  it('employee sees only own enrollments via /benefits/my-elections', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/benefits/my-elections',
      headers: auth(aisha),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // All enrollments belong to Aisha
    for (const e of body.enrollments) {
      expect(e.employeeId).toBe(SEED.EMP_AISHA)
    }
    // All dependents belong to Aisha
    for (const d of body.dependents) {
      expect(d.employeeId).toBe(SEED.EMP_AISHA)
    }
    // All life events belong to Aisha
    for (const le of body.lifeEvents) {
      expect(le.employeeId).toBe(SEED.EMP_AISHA)
    }
  })

  it('employee can create a dependent for themselves', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/benefits/dependents',
      headers: auth(aisha),
      payload: {
        firstName: 'Zara',
        lastName: 'Khan',
        relationship: 'child',
        dateOfBirth: '2020-03-15',
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.employeeId).toBe(SEED.EMP_AISHA)
    expect(body.firstName).toBe('Zara')
    expect(body.isActive).toBe(true)
  })

  it('employee can edit own dependent', async () => {
    // First get Aisha's dependents
    const listRes = await app.inject({
      method: 'GET',
      url: '/benefits/dependents',
      headers: auth(aisha),
    })
    // Employee can't list all dependents (admin endpoint), so use my-elections
    const myRes = await app.inject({
      method: 'GET',
      url: '/benefits/my-elections',
      headers: auth(aisha),
    })
    const myBody = myRes.json()
    const childDep = myBody.dependents.find((d: any) => d.firstName === 'Zara')
    expect(childDep).toBeTruthy()

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/benefits/dependents/${childDep.id}`,
      headers: auth(aisha),
      payload: { firstName: 'Zara Updated' },
    })
    expect(patchRes.statusCode).toBe(200)
    expect(patchRes.json().firstName).toBe('Zara Updated')
  })

  it('employee CANNOT create enrollment for another employee', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/benefits/enrollments',
      headers: auth(aisha),
      payload: {
        employeeId: SEED.EMP_PRIYA, // trying to create for Priya
        enrollmentPeriodId: SEED.BEN_PERIOD_OPEN,
        benefitPlanId: SEED.BEN_PLAN_DENTAL,
        coverageTier: 'employee_only',
        employeePremium: 30,
        employerPremium: 30,
      },
    })
    expect(res.statusCode).toBe(403)
  })

  it('employee CANNOT create dependent for another employee', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/benefits/dependents',
      headers: auth(aisha),
      payload: {
        employeeId: SEED.EMP_PRIYA,
        firstName: 'Fake',
        lastName: 'Dep',
        relationship: 'child',
      },
    })
    expect(res.statusCode).toBe(403)
  })

  it('employee CANNOT report life event for another employee', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/benefits/life-events',
      headers: auth(aisha),
      payload: {
        employeeId: SEED.EMP_PRIYA,
        eventType: 'birth',
        eventDate: '2026-09-15',
      },
    })
    expect(res.statusCode).toBe(403)
  })
})

// ─── Enrollment window enforcement ──────────────────────────────────────────

describe('benefits — enrollment window enforcement', () => {
  it('rejects enrollment creation when period is not active', async () => {
    // BEN_PERIOD_CLOSED has status 'closed'
    const res = await app.inject({
      method: 'POST',
      url: '/benefits/enrollments',
      headers: auth(aisha),
      payload: {
        enrollmentPeriodId: SEED.BEN_PERIOD_CLOSED,
        benefitPlanId: SEED.BEN_PLAN_DENTAL,
        coverageTier: 'employee_only',
        employeePremium: 30,
        employerPremium: 30,
      },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error.message).toMatch(/not active/i)
  })

  it('allows enrollment creation when period is active', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/benefits/enrollments',
      headers: auth(aisha),
      payload: {
        enrollmentPeriodId: SEED.BEN_PERIOD_OPEN,
        benefitPlanId: SEED.BEN_PLAN_DENTAL,
        coverageTier: 'employee_only',
        employeePremium: 30,
        employerPremium: 30,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('draft')
    expect(body.enrollmentPeriodId).toBe(SEED.BEN_PERIOD_OPEN)
  })

  it('rejects submission when period is no longer active', async () => {
    // Create a period, activate it, create an enrollment, then close the period
    const createPeriodRes = await app.inject({
      method: 'POST',
      url: '/benefits/periods',
      headers: auth(admin),
      payload: { name: `Temp Period ${Date.now()}`, startsAt: '2026-01-01', endsAt: '2026-01-31' },
    })
    const period = createPeriodRes.json()

    // Activate
    await app.inject({
      method: 'POST',
      url: `/benefits/periods/${period.id}/status`,
      headers: auth(admin),
      payload: { status: 'active' },
    })

    // Create enrollment
    const createEnrollRes = await app.inject({
      method: 'POST',
      url: '/benefits/enrollments',
      headers: auth(aisha),
      payload: {
        enrollmentPeriodId: period.id,
        benefitPlanId: SEED.BEN_PLAN_MEDICAL,
        coverageTier: 'employee_only',
        employeePremium: 250,
        employerPremium: 250,
      },
    })
    const enrollment = createEnrollRes.json()

    // Close the period
    await app.inject({
      method: 'POST',
      url: `/benefits/periods/${period.id}/status`,
      headers: auth(admin),
      payload: { status: 'closed' },
    })

    // Try to submit — should fail
    const submitRes = await app.inject({
      method: 'POST',
      url: `/benefits/enrollments/${enrollment.id}/submit`,
      headers: auth(aisha),
    })
    expect(submitRes.statusCode).toBe(400)
    expect(submitRes.json().error.message).toMatch(/not active/i)
  })
})

// ─── Enrollment period state machine ─────────────────────────────────────────

describe('benefits — enrollment period transitions', () => {
  it('rejects invalid forward transition (draft → closed)', async () => {
    // Create a new draft period
    const createRes = await app.inject({
      method: 'POST',
      url: '/benefits/periods',
      headers: auth(admin),
      payload: { name: `Draft Period ${Date.now()}`, startsAt: '2026-01-01', endsAt: '2026-01-31' },
    })
    const period = createRes.json()

    // Try to skip to closed
    const res = await app.inject({
      method: 'POST',
      url: `/benefits/periods/${period.id}/status`,
      headers: auth(admin),
      payload: { status: 'closed' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/Cannot transition/i)
  })

  it('allows draft → active → closed → finalized', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/benefits/periods',
      headers: auth(admin),
      payload: { name: `Full Transition ${Date.now()}`, startsAt: '2026-01-01', endsAt: '2026-01-31' },
    })
    const period = createRes.json()

    // draft → active
    const r1 = await app.inject({
      method: 'POST',
      url: `/benefits/periods/${period.id}/status`,
      headers: auth(admin),
      payload: { status: 'active' },
    })
    expect(r1.statusCode).toBe(200)
    expect(r1.json().status).toBe('active')

    // active → closed
    const r2 = await app.inject({
      method: 'POST',
      url: `/benefits/periods/${period.id}/status`,
      headers: auth(admin),
      payload: { status: 'closed' },
    })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().status).toBe('closed')

    // closed → finalized
    const r3 = await app.inject({
      method: 'POST',
      url: `/benefits/periods/${period.id}/status`,
      headers: auth(admin),
      payload: { status: 'finalized' },
    })
    expect(r3.statusCode).toBe(200)
    expect(r3.json().status).toBe('finalized')
  })
})

// ─── Dependent deactivation ──────────────────────────────────────────────────

describe('benefits — dependent deactivation', () => {
  it('deactivates a dependent (is_active flips to false, no hard delete)', async () => {
    // Create a dependent
    const createRes = await app.inject({
      method: 'POST',
      url: '/benefits/dependents',
      headers: auth(aisha),
      payload: {
        firstName: 'ToDeactivate',
        lastName: 'Test',
        relationship: 'child',
        dateOfBirth: '2015-06-01',
      },
    })
    expect(createRes.statusCode).toBe(200)
    const dep = createRes.json()
    expect(dep.isActive).toBe(true)

    // Deactivate
    const deactRes = await app.inject({
      method: 'POST',
      url: `/benefits/dependents/${dep.id}/deactivate`,
      headers: auth(aisha),
    })
    expect(deactRes.statusCode).toBe(200)
    expect(deactRes.json().isActive).toBe(false)

    // Verify it still exists (not hard-deleted) — admin can see it
    const listRes = await app.inject({
      method: 'GET',
      url: '/benefits/dependents',
      headers: auth(admin),
    })
    const allDeps = listRes.json()
    const found = allDeps.find((d: any) => d.id === dep.id)
    expect(found).toBeTruthy()
    expect(found!.isActive).toBe(false)
  })
})

// ─── Unique constraint: one enrollment per plan per period ───────────────────

describe('benefits — unique_employee_plan_period constraint', () => {
  it('rejects duplicate enrollment for same plan+period with clean error', async () => {
    // Aisha already has BEN_ENROLLMENT_AISHA for BEN_PLAN_MEDICAL in BEN_PERIOD_OPEN
    const res = await app.inject({
      method: 'POST',
      url: '/benefits/enrollments',
      headers: auth(aisha),
      payload: {
        enrollmentPeriodId: SEED.BEN_PERIOD_OPEN,
        benefitPlanId: SEED.BEN_PLAN_MEDICAL,
        coverageTier: 'employee_only',
        employeePremium: 250,
        employerPremium: 250,
      },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toBeDefined()
    expect(body.error.message).toMatch(/already have an enrollment/i)
  })
})

// ─── Plan CRUD ───────────────────────────────────────────────────────────────

describe('benefits — plan CRUD', () => {
  let planId: string

  it('admin creates a plan', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/benefits/plans',
      headers: auth(admin),
      payload: {
        name: 'Test Vision Plan',
        description: 'Vision coverage for employees',
        planType: 'vision',
        carrierName: 'VSP',
        coverageTiers: ['employee_only', 'family'],
        employerContributionPct: 60,
        employeeCost: { employee_only: 20, family: 60 },
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.name).toBe('Test Vision Plan')
    expect(body.planType).toBe('vision')
    planId = body.id
  })

  it('admin updates a plan', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/benefits/plans/${planId}`,
      headers: auth(admin),
      payload: { carrierName: 'VSP Updated' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().carrierName).toBe('VSP Updated')
  })
})

// ─── Life event lifecycle ────────────────────────────────────────────────────

describe('benefits — life event lifecycle', () => {
  it('employee reports a life event, admin acknowledges it', async () => {
    // Report
    const reportRes = await app.inject({
      method: 'POST',
      url: '/benefits/life-events',
      headers: auth(aisha),
      payload: {
        eventType: 'birth',
        eventDate: '2026-09-20',
        description: 'New baby born',
      },
    })
    expect(reportRes.statusCode).toBe(200)
    const event = reportRes.json()
    expect(event.status).toBe('reported')
    expect(event.employeeId).toBe(SEED.EMP_AISHA)

    // Acknowledge
    const ackRes = await app.inject({
      method: 'POST',
      url: `/benefits/life-events/${event.id}/acknowledge`,
      headers: auth(admin),
    })
    expect(ackRes.statusCode).toBe(200)
    expect(ackRes.json().status).toBe('acknowledged')
    expect(ackRes.json().acknowledgedBy).toBeDefined()
  })

  it('rejects acknowledgment of already acknowledged event', async () => {
    // The seeded life event for Aisha is 'reported', acknowledge it
    const ackRes = await app.inject({
      method: 'POST',
      url: `/benefits/life-events/${SEED.BEN_LIFE_EVENT_AISHA}/acknowledge`,
      headers: auth(admin),
    })
    expect(ackRes.statusCode).toBe(200)

    // Try to acknowledge again
    const reAck = await app.inject({
      method: 'POST',
      url: `/benefits/life-events/${SEED.BEN_LIFE_EVENT_AISHA}/acknowledge`,
      headers: auth(admin),
    })
    expect(reAck.statusCode).toBe(400)
    expect(reAck.json().error.message).toMatch(/only reported/i)
  })
})

// ─── Enrollment submit/confirm/withdraw lifecycle ────────────────────────────

describe('benefits — enrollment lifecycle', () => {
  it('employee submits, admin confirms, enrollment is confirmed', async () => {
    // Create a new period + enrollment for this test
    const periodRes = await app.inject({
      method: 'POST',
      url: '/benefits/periods',
      headers: auth(admin),
      payload: { name: `Lifecycle Test ${Date.now()}`, startsAt: '2026-01-01', endsAt: '2026-12-31' },
    })
    const period = periodRes.json()
    await app.inject({
      method: 'POST',
      url: `/benefits/periods/${period.id}/status`,
      headers: auth(admin),
      payload: { status: 'active' },
    })

    // Create enrollment
    const enrollRes = await app.inject({
      method: 'POST',
      url: '/benefits/enrollments',
      headers: auth(aisha),
      payload: {
        enrollmentPeriodId: period.id,
        benefitPlanId: SEED.BEN_PLAN_DENTAL,
        coverageTier: 'employee_spouse',
        employeePremium: 60,
        employerPremium: 40,
      },
    })
    const enrollment = enrollRes.json()
    expect(enrollment.status).toBe('draft')

    // Submit
    const submitRes = await app.inject({
      method: 'POST',
      url: `/benefits/enrollments/${enrollment.id}/submit`,
      headers: auth(aisha),
    })
    expect(submitRes.statusCode).toBe(200)
    expect(submitRes.json().status).toBe('submitted')
    expect(submitRes.json().submittedAt).toBeTruthy()

    // Confirm (admin)
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/benefits/enrollments/${enrollment.id}/confirm`,
      headers: auth(admin),
    })
    expect(confirmRes.statusCode).toBe(200)
    expect(confirmRes.json().status).toBe('confirmed')
    expect(confirmRes.json().confirmedAt).toBeTruthy()
  })

  it('employee submits then withdraws enrollment', async () => {
    const periodRes = await app.inject({
      method: 'POST',
      url: '/benefits/periods',
      headers: auth(admin),
      payload: { name: `Withdraw Test ${Date.now()}`, startsAt: '2026-01-01', endsAt: '2026-12-31' },
    })
    const period = periodRes.json()
    await app.inject({
      method: 'POST',
      url: `/benefits/periods/${period.id}/status`,
      headers: auth(admin),
      payload: { status: 'active' },
    })

    const enrollRes = await app.inject({
      method: 'POST',
      url: '/benefits/enrollments',
      headers: auth(aisha),
      payload: {
        enrollmentPeriodId: period.id,
        benefitPlanId: SEED.BEN_PLAN_MEDICAL,
        coverageTier: 'employee_only',
        employeePremium: 250,
        employerPremium: 250,
      },
    })
    const enrollment = enrollRes.json()

    // Submit
    await app.inject({
      method: 'POST',
      url: `/benefits/enrollments/${enrollment.id}/submit`,
      headers: auth(aisha),
    })

    // Withdraw
    const withdrawRes = await app.inject({
      method: 'POST',
      url: `/benefits/enrollments/${enrollment.id}/withdraw`,
      headers: auth(aisha),
    })
    expect(withdrawRes.statusCode).toBe(200)
    expect(withdrawRes.json().status).toBe('withdrawn')
    expect(withdrawRes.json().withdrawnAt).toBeTruthy()
  })
})
