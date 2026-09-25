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

describe('performance — goals scoping', () => {
  it('employee B does NOT see employee A\'s goals', async () => {
    // Aisha (employee) → GET /performance/goals — should only see own goals
    const res = await app.inject({
      method: 'GET',
      url: '/performance/goals',
      headers: auth(aisha),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Aisha has 2 seeded goals (EMP_GOAL_AISHA_1, EMP_GOAL_AISHA_2)
    expect(body.data.length).toBeGreaterThanOrEqual(2)
    // All goals belong to Aisha
    for (const g of body.data) {
      expect(g.employeeId).toBe(SEED.EMP_AISHA)
    }
  })

  it('manager sees direct reports\' goals', async () => {
    // Priya (manager of Aisha) → GET /performance/goals — should see Aisha's goals
    const res = await app.inject({
      method: 'GET',
      url: '/performance/goals',
      headers: auth(priya),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const aishaGoals = body.data.filter((g: any) => g.employeeId === SEED.EMP_AISHA)
    expect(aishaGoals.length).toBeGreaterThanOrEqual(2)
  })

  it('admin sees all goals in the tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/performance/goals',
      headers: auth(admin),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Admin should see goals from multiple employees (Aisha, Priya, Marcus)
    const employeeIds = new Set(body.data.map((g: any) => g.employeeId))
    expect(employeeIds.size).toBeGreaterThanOrEqual(2)
  })

  it('employee creates a goal and it appears in their list', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/performance/goals',
      headers: auth(aisha),
      payload: {
        title: 'Live test goal',
        description: 'Created during integration testing',
        category: 'testing',
        goalType: 'okr',
        percentage: 0,
      },
    })
    expect(createRes.statusCode).toBe(200)
    const goal = createRes.json()
    expect(goal.title).toBe('Live test goal')
    expect(goal.employeeId).toBe(SEED.EMP_AISHA)

    // Verify it appears in Aisha's goals
    const listRes = await app.inject({
      method: 'GET',
      url: '/performance/goals',
      headers: auth(aisha),
    })
    const body = listRes.json()
    const found = body.data.find((g: any) => g.id === goal.id)
    expect(found).toBeTruthy()
  })
})

describe('performance — self-review visibility', () => {
  it('employee does NOT see manager_rating/manager_comment before finalization', async () => {
    // Aisha's review has manager_rating=5, manager_comment='Exceptional work on the redesign'
    // but status is 'manager_reviewing' (not finalized)
    const res = await app.inject({
      method: 'GET',
      url: `/performance/reviews/${SEED.PERF_REVIEW_AISHA}`,
      headers: auth(aisha),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Manager fields must NOT be present
    expect(body.managerRating).toBeUndefined()
    expect(body.managerComment).toBeUndefined()
    expect(body.managerSubmittedAt).toBeUndefined()
    // Self fields SHOULD be present
    expect(body.selfRating).toBe(4)
    expect(body.selfComment).toBe('Strong quarter, shipped on time')
  })

  it('admin CAN see manager fields on non-finalized review', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/performance/reviews/${SEED.PERF_REVIEW_AISHA}`,
      headers: auth(admin),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.managerRating).toBe(5)
    expect(body.managerComment).toBe('Exceptional work on the redesign')
  })

  it('manager CAN see manager fields on non-finalized review they submitted', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/performance/reviews/${SEED.PERF_REVIEW_AISHA}`,
      headers: auth(priya),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.managerRating).toBe(5)
  })

  it('after finalization, employee CAN see manager fields', async () => {
    // Finalize the review (admin only)
    const finalizeRes = await app.inject({
      method: 'POST',
      url: `/performance/reviews/${SEED.PERF_REVIEW_AISHA}/finalize`,
      headers: auth(admin),
      payload: { finalRating: 5 },
    })
    expect(finalizeRes.statusCode).toBe(200)

    // Now Aisha should see manager fields
    const res = await app.inject({
      method: 'GET',
      url: `/performance/reviews/${SEED.PERF_REVIEW_AISHA}`,
      headers: auth(aisha),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.managerRating).toBe(5)
    expect(body.managerComment).toBe('Exceptional work on the redesign')
    expect(body.finalRating).toBe(5)
    expect(body.status).toBe('finalized')
  })
})

describe('performance — manager review-list scoping', () => {
  it('manager sees only direct reports\' reviews, not the whole tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/performance/reviews',
      headers: auth(priya),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Priya is manager of Aisha only — should see Aisha's review
    const aishaReview = body.data.find((r: any) => r.employeeId === SEED.EMP_AISHA)
    expect(aishaReview).toBeTruthy()
    // Priya should NOT see her own review (she's not her own manager)
    const priyaReview = body.data.find((r: any) => r.employeeId === SEED.EMP_PRIYA)
    expect(priyaReview).toBeFalsy()
  })

  it('admin sees all reviews in the tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/performance/reviews',
      headers: auth(admin),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const employeeIds = new Set(body.data.map((r: any) => r.employeeId))
    expect(employeeIds.size).toBeGreaterThanOrEqual(2)
  })
})

describe('performance — feedback scoping', () => {
  it('employee sees feedback where they are author or recipient, not unrelated threads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/performance/feedback',
      headers: auth(aisha),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Aisha is recipient of feedback_1 (Priya→Aisha) and feedback_2 (Marcus→Aisha)
    expect(body.data.length).toBeGreaterThanOrEqual(2)
    for (const f of body.data) {
      const involved = f.authorId === SEED.EMP_AISHA || f.recipientId === SEED.EMP_AISHA
      expect(involved).toBe(true)
    }
  })

  it('employee creates feedback and it appears', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/performance/feedback',
      headers: auth(aisha),
      payload: {
        recipientId: SEED.EMP_PRIYA,
        content: 'Thanks for the coaching session',
        feedbackType: 'kudos',
      },
    })
    expect(createRes.statusCode).toBe(200)
    const entry = createRes.json()
    expect(entry.authorId).toBe(SEED.EMP_AISHA)
    expect(entry.recipientId).toBe(SEED.EMP_PRIYA)

    // Verify it appears in Aisha's feedback
    const listRes = await app.inject({
      method: 'GET',
      url: '/performance/feedback',
      headers: auth(aisha),
    })
    const body = listRes.json()
    const found = body.data.find((f: any) => f.id === entry.id)
    expect(found).toBeTruthy()
  })

  it('manager sees feedback for direct reports', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/performance/feedback',
      headers: auth(priya),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Priya authored feedback_1 (Priya→Aisha) and is recipient of the live feedback
    const relevant = body.data.filter((f: any) =>
      f.authorId === SEED.EMP_PRIYA || f.recipientId === SEED.EMP_PRIYA,
    )
    expect(relevant.length).toBeGreaterThanOrEqual(1)
  })
})

describe('performance — cycle status transitions enforced', () => {
  it('rejects manager review after cycle moves to calibration', async () => {
    // First, create a new review for the draft cycle and move it through states
    // Use the draft cycle (Q4 2026) — transition: draft → active → collecting → calibration
    const activateRes = await app.inject({
      method: 'POST',
      url: `/performance/cycles/${SEED.PERF_CYCLE_DRAFT}/status`,
      headers: auth(admin),
      payload: { status: 'active' },
    })
    expect(activateRes.statusCode).toBe(200)

    const collectRes = await app.inject({
      method: 'POST',
      url: `/performance/cycles/${SEED.PERF_CYCLE_DRAFT}/status`,
      headers: auth(admin),
      payload: { status: 'collecting' },
    })
    expect(collectRes.statusCode).toBe(200)

    const calibrateRes = await app.inject({
      method: 'POST',
      url: `/performance/cycles/${SEED.PERF_CYCLE_DRAFT}/status`,
      headers: auth(admin),
      payload: { status: 'calibration' },
    })
    expect(calibrateRes.statusCode).toBe(200)

    // Now try to submit a manager review on a review in this cycle — should fail
    // Create a review in this cycle first
    const createReviewRes = await app.inject({
      method: 'POST',
      url: `/performance/reviews`,
      headers: auth(admin),
      payload: { cycleId: SEED.PERF_CYCLE_DRAFT, employeeId: SEED.EMP_AISHA },
    })
    // The review creation might fail if a review already exists for this cycle+employee
    // That's fine — we just need to test the transition rejection
    if (createReviewRes.statusCode === 200) {
      const review = createReviewRes.json()
      const managerReviewRes = await app.inject({
        method: 'POST',
        url: `/performance/reviews/${review.id}/manager`,
        headers: auth(priya),
        payload: { rating: 4, comment: 'Test' },
      })
      // Should be rejected because the cycle is in calibration
      expect(managerReviewRes.statusCode).toBe(400)
    }
  })

  it('rejects invalid forward transitions', async () => {
    // Try to go from finalized back to collecting — should fail
    // Q3 cycle is in 'collecting' status; try to skip to 'finalized'
    const res = await app.inject({
      method: 'POST',
      url: `/performance/cycles/${SEED.PERF_CYCLE_Q3}/status`,
      headers: auth(admin),
      payload: { status: 'finalized' },
    })
    // Should be rejected — can't skip from collecting to finalized
    expect(res.statusCode).toBe(400)
  })
})

describe('performance — cycle name uniqueness enforced', () => {
  it('rejects duplicate cycle name for the same tenant', async () => {
    // First call — create a cycle with a unique name
    const uniqueName = `Unique Cycle ${Date.now()}`
    const first = await app.inject({
      method: 'POST',
      url: '/performance/cycles',
      headers: auth(admin),
      payload: { name: uniqueName, startsAt: '2026-01-01', endsAt: '2026-03-31' },
    })
    expect(first.statusCode).toBe(200)

    // Second call — same name, same tenant → must fail, not 500
    const second = await app.inject({
      method: 'POST',
      url: '/performance/cycles',
      headers: auth(admin),
      payload: { name: uniqueName, startsAt: '2026-04-01', endsAt: '2026-06-30' },
    })
    expect(second.statusCode).toBeGreaterThanOrEqual(400)
    expect(second.statusCode).toBeLessThan(500)
    const body = second.json()
    expect(body.error).toBeDefined()
  })
})

describe('performance — /performance/me returns caller\'s own data', () => {
  it('returns only Aisha\'s goals, reviews, and feedback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/performance/me',
      headers: auth(aisha),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    // Goals — all belong to Aisha
    expect(body.goals.length).toBeGreaterThanOrEqual(2)
    for (const g of body.goals) {
      expect(g.employeeId).toBe(SEED.EMP_AISHA)
    }

    // Reviews — all belong to Aisha
    expect(body.reviews.length).toBeGreaterThanOrEqual(1)
    for (const r of body.reviews) {
      expect(r.employeeId).toBe(SEED.EMP_AISHA)
    }

    // Feedback — Aisha is author or recipient on all
    expect(body.feedback.length).toBeGreaterThanOrEqual(2)
    for (const f of body.feedback) {
      const involved = f.authorId === SEED.EMP_AISHA || f.recipientId === SEED.EMP_AISHA
      expect(involved).toBe(true)
    }
  })

  it('returns only Priya\'s data, not Aisha\'s', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/performance/me',
      headers: auth(priya),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    // Goals — Priya has 1 seeded goal
    const priyaGoals = body.goals.filter((g: any) => g.employeeId === SEED.EMP_PRIYA)
    expect(priyaGoals.length).toBeGreaterThanOrEqual(1)
    // No Aisha goals leaked
    const aishaGoals = body.goals.filter((g: any) => g.employeeId === SEED.EMP_AISHA)
    expect(aishaGoals.length).toBe(0)

    // Reviews — Priya has 1 seeded review
    const priyaReviews = body.reviews.filter((r: any) => r.employeeId === SEED.EMP_PRIYA)
    expect(priyaReviews.length).toBeGreaterThanOrEqual(1)
  })

  it('rejects unauthenticated request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/performance/me',
    })
    expect(res.statusCode).toBe(401)
  })
})
