/**
 * Benefits repository. Query helpers for benefit_plans, enrollment_periods,
 * benefit_enrollments, benefit_dependents, enrollment_dependents, and life_events.
 * All queries run within tenant-scoped transactions.
 */

import type { Q } from '../../db/index.js'
import { newId } from '../../db/index.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BenefitPlan {
  id: string
  tenantId: string
  name: string
  description: string | null
  planType: string
  carrierName: string | null
  coverageTiers: string[]
  employerContributionPct: number | null
  employeeCost: unknown
  isActive: boolean
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface EnrollmentPeriod {
  id: string
  tenantId: string
  name: string
  description: string | null
  periodType: string
  status: string
  startsAt: string
  endsAt: string
  coverageStarts: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface BenefitEnrollment {
  id: string
  tenantId: string
  employeeId: string
  enrollmentPeriodId: string
  benefitPlanId: string
  coverageTier: string
  employeePremium: number
  employerPremium: number
  status: string
  submittedAt: string | null
  confirmedAt: string | null
  withdrawnAt: string | null
  notes: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface BenefitDependent {
  id: string
  tenantId: string
  employeeId: string
  firstName: string
  lastName: string
  relationship: string
  dateOfBirth: string | null
  ssnEnc: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface LifeEvent {
  id: string
  tenantId: string
  employeeId: string
  eventType: string
  eventDate: string
  description: string | null
  status: string
  enrollmentPeriodId: string | null
  reportedAt: string
  acknowledgedBy: string | null
  acknowledgedAt: string | null
  createdAt: string
}

// ─── Column Aliases ──────────────────────────────────────────────────────────

const PLAN_COLS = `id, tenant_id AS "tenantId", name, description,
  plan_type AS "planType", carrier_name AS "carrierName",
  coverage_tiers AS "coverageTiers", employer_contribution_pct AS "employerContributionPct",
  employee_cost AS "employeeCost", is_active AS "isActive",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`

const PERIOD_COLS = `id, tenant_id AS "tenantId", name, description,
  period_type AS "periodType", status, starts_at AS "startsAt", ends_at AS "endsAt",
  coverage_starts AS "coverageStarts", created_by AS "createdBy",
  created_at AS "createdAt", updated_at AS "updatedAt"`

const ENROLLMENT_COLS = `id, tenant_id AS "tenantId", employee_id AS "employeeId",
  enrollment_period_id AS "enrollmentPeriodId", benefit_plan_id AS "benefitPlanId",
  coverage_tier AS "coverageTier", employee_premium AS "employeePremium",
  employer_premium AS "employerPremium", status, submitted_at AS "submittedAt",
  confirmed_at AS "confirmedAt", withdrawn_at AS "withdrawnAt", notes,
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`

const DEPENDENT_COLS = `id, tenant_id AS "tenantId", employee_id AS "employeeId",
  first_name AS "firstName", last_name AS "lastName", relationship,
  date_of_birth AS "dateOfBirth", ssn_enc AS "ssnEnc",
  is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"`

const LIFE_EVENT_COLS = `id, tenant_id AS "tenantId", employee_id AS "employeeId",
  event_type AS "eventType", event_date AS "eventDate", description, status,
  enrollment_period_id AS "enrollmentPeriodId", reported_at AS "reportedAt",
  acknowledged_by AS "acknowledgedBy", acknowledged_at AS "acknowledgedAt",
  created_at AS "createdAt"`

// ─── Benefit Plans ───────────────────────────────────────────────────────────

export async function listBenefitPlans(q: Q, opts: { activeOnly?: boolean } = {}): Promise<BenefitPlan[]> {
  const where = opts.activeOnly ? 'WHERE is_active = true' : ''
  const res = await q.query<BenefitPlan>(`SELECT ${PLAN_COLS} FROM benefit_plans ${where} ORDER BY name`, [])
  return res.rows
}

export async function getBenefitPlan(q: Q, id: string): Promise<BenefitPlan | null> {
  const res = await q.query<BenefitPlan>(`SELECT ${PLAN_COLS} FROM benefit_plans WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

export async function createBenefitPlan(
  q: Q,
  opts: {
    name: string
    description?: string
    planType: string
    carrierName?: string
    coverageTiers: string[]
    employerContributionPct?: number
    employeeCost: unknown
    createdBy: string
  },
): Promise<BenefitPlan> {
  const id = newId()
  await q.exec(
    `INSERT INTO benefit_plans
       (id, tenant_id, name, description, plan_type, carrier_name,
        coverage_tiers, employer_contribution_pct, employee_cost, created_by)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [id, opts.name, opts.description ?? null, opts.planType, opts.carrierName ?? null,
     opts.coverageTiers, opts.employerContributionPct ?? null, JSON.stringify(opts.employeeCost), opts.createdBy],
  )
  return (await getBenefitPlan(q, id))!
}

export async function updateBenefitPlan(
  q: Q,
  id: string,
  opts: {
    name?: string
    description?: string
    planType?: string
    carrierName?: string
    coverageTiers?: string[]
    employerContributionPct?: number
    employeeCost?: unknown
    isActive?: boolean
  },
): Promise<void> {
  const sets: string[] = ['updated_at = now()']
  const params: unknown[] = [id]
  if (opts.name !== undefined) { params.push(opts.name); sets.push(`name = $${params.length}`) }
  if (opts.description !== undefined) { params.push(opts.description); sets.push(`description = $${params.length}`) }
  if (opts.planType !== undefined) { params.push(opts.planType); sets.push(`plan_type = $${params.length}`) }
  if (opts.carrierName !== undefined) { params.push(opts.carrierName); sets.push(`carrier_name = $${params.length}`) }
  if (opts.coverageTiers !== undefined) { params.push(opts.coverageTiers); sets.push(`coverage_tiers = $${params.length}`) }
  if (opts.employerContributionPct !== undefined) { params.push(opts.employerContributionPct); sets.push(`employer_contribution_pct = $${params.length}`) }
  if (opts.employeeCost !== undefined) { params.push(JSON.stringify(opts.employeeCost)); sets.push(`employee_cost = $${params.length}::jsonb`) }
  if (opts.isActive !== undefined) { params.push(opts.isActive); sets.push(`is_active = $${params.length}`) }
  await q.exec(`UPDATE benefit_plans SET ${sets.join(', ')} WHERE id = $1`, params)
}

// ─── Enrollment Periods ──────────────────────────────────────────────────────

export async function listEnrollmentPeriods(q: Q, opts: { status?: string } = {}): Promise<EnrollmentPeriod[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.status) { params.push(opts.status); conditions.push(`status = $${params.length}`) }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const res = await q.query<EnrollmentPeriod>(`SELECT ${PERIOD_COLS} FROM enrollment_periods ${where} ORDER BY starts_at DESC`, params)
  return res.rows
}

export async function getEnrollmentPeriod(q: Q, id: string): Promise<EnrollmentPeriod | null> {
  const res = await q.query<EnrollmentPeriod>(`SELECT ${PERIOD_COLS} FROM enrollment_periods WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

export async function createEnrollmentPeriod(
  q: Q,
  opts: {
    name: string
    description?: string
    periodType?: string
    startsAt: string
    endsAt: string
    coverageStarts?: string
    createdBy: string
  },
): Promise<EnrollmentPeriod> {
  const id = newId()
  await q.exec(
    `INSERT INTO enrollment_periods
       (id, tenant_id, name, description, period_type, starts_at, ends_at, coverage_starts, created_by)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4, $5, $6, $7, $8)`,
    [id, opts.name, opts.description ?? null, opts.periodType ?? 'open_enrollment',
     opts.startsAt, opts.endsAt, opts.coverageStarts ?? null, opts.createdBy],
  )
  return (await getEnrollmentPeriod(q, id))!
}

export async function updateEnrollmentPeriodStatus(q: Q, id: string, status: string): Promise<void> {
  await q.exec(`UPDATE enrollment_periods SET status = $2, updated_at = now() WHERE id = $1`, [id, status])
}

// ─── Benefit Enrollments ─────────────────────────────────────────────────────

export async function listBenefitEnrollments(
  q: Q,
  opts: { employeeId?: string; periodId?: string; page?: number; pageSize?: number } = {},
): Promise<{ data: BenefitEnrollment[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25))
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.employeeId) { params.push(opts.employeeId); conditions.push(`employee_id = $${params.length}`) }
  if (opts.periodId) { params.push(opts.periodId); conditions.push(`enrollment_period_id = $${params.length}`) }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  params.push(pageSize, (page - 1) * pageSize)

  const [dataRes, countRes] = await Promise.all([
    q.query<BenefitEnrollment>(
      `SELECT ${ENROLLMENT_COLS} FROM benefit_enrollments ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    q.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM benefit_enrollments ${where}`,
      params.slice(0, -2),
    ),
  ])
  return { data: dataRes.rows, total: countRes.rows[0]?.count ?? 0 }
}

export async function getBenefitEnrollment(q: Q, id: string): Promise<BenefitEnrollment | null> {
  const res = await q.query<BenefitEnrollment>(`SELECT ${ENROLLMENT_COLS} FROM benefit_enrollments WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

export async function createBenefitEnrollment(
  q: Q,
  opts: {
    employeeId: string
    enrollmentPeriodId: string
    benefitPlanId: string
    coverageTier: string
    employeePremium: number
    employerPremium: number
    notes?: string
    createdBy: string
  },
): Promise<BenefitEnrollment> {
  const id = newId()
  await q.exec(
    `INSERT INTO benefit_enrollments
       (id, tenant_id, employee_id, enrollment_period_id, benefit_plan_id,
        coverage_tier, employee_premium, employer_premium, notes, created_by)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, opts.employeeId, opts.enrollmentPeriodId, opts.benefitPlanId,
     opts.coverageTier, opts.employeePremium, opts.employerPremium,
     opts.notes ?? null, opts.createdBy],
  )
  return (await getBenefitEnrollment(q, id))!
}

export async function updateBenefitEnrollmentStatus(
  q: Q,
  id: string,
  status: string,
  extra?: { submittedAt?: boolean; confirmedAt?: boolean; withdrawnAt?: boolean },
): Promise<void> {
  const sets = ['status = $2', 'updated_at = now()']
  const params: unknown[] = [id, status]
  if (extra?.submittedAt) sets.push(`submitted_at = now()`)
  if (extra?.confirmedAt) sets.push(`confirmed_at = now()`)
  if (extra?.withdrawnAt) sets.push(`withdrawn_at = now()`)
  await q.exec(`UPDATE benefit_enrollments SET ${sets.join(', ')} WHERE id = $1`, params)
}

// ─── Benefit Dependents ──────────────────────────────────────────────────────

export async function listBenefitDependents(
  q: Q,
  opts: { employeeId?: string; activeOnly?: boolean } = {},
): Promise<BenefitDependent[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.employeeId) { params.push(opts.employeeId); conditions.push(`employee_id = $${params.length}`) }
  if (opts.activeOnly) conditions.push(`is_active = true`)
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const res = await q.query<BenefitDependent>(`SELECT ${DEPENDENT_COLS} FROM benefit_dependents ${where} ORDER BY last_name, first_name`, params)
  return res.rows
}

export async function getBenefitDependent(q: Q, id: string): Promise<BenefitDependent | null> {
  const res = await q.query<BenefitDependent>(`SELECT ${DEPENDENT_COLS} FROM benefit_dependents WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

export async function createBenefitDependent(
  q: Q,
  opts: {
    employeeId: string
    firstName: string
    lastName: string
    relationship: string
    dateOfBirth?: string
    ssnEnc?: string
  },
): Promise<BenefitDependent> {
  const id = newId()
  await q.exec(
    `INSERT INTO benefit_dependents
       (id, tenant_id, employee_id, first_name, last_name, relationship, date_of_birth, ssn_enc)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4, $5, $6, $7)`,
    [id, opts.employeeId, opts.firstName, opts.lastName, opts.relationship,
     opts.dateOfBirth ?? null, opts.ssnEnc ?? null],
  )
  return (await getBenefitDependent(q, id))!
}

export async function updateBenefitDependent(
  q: Q,
  id: string,
  opts: {
    firstName?: string
    lastName?: string
    relationship?: string
    dateOfBirth?: string
    ssnEnc?: string
  },
): Promise<void> {
  const sets: string[] = ['updated_at = now()']
  const params: unknown[] = [id]
  if (opts.firstName !== undefined) { params.push(opts.firstName); sets.push(`first_name = $${params.length}`) }
  if (opts.lastName !== undefined) { params.push(opts.lastName); sets.push(`last_name = $${params.length}`) }
  if (opts.relationship !== undefined) { params.push(opts.relationship); sets.push(`relationship = $${params.length}`) }
  if (opts.dateOfBirth !== undefined) { params.push(opts.dateOfBirth); sets.push(`date_of_birth = $${params.length}`) }
  if (opts.ssnEnc !== undefined) { params.push(opts.ssnEnc); sets.push(`ssn_enc = $${params.length}`) }
  await q.exec(`UPDATE benefit_dependents SET ${sets.join(', ')} WHERE id = $1`, params)
}

export async function deactivateBenefitDependent(q: Q, id: string): Promise<void> {
  await q.exec(`UPDATE benefit_dependents SET is_active = false, updated_at = now() WHERE id = $1`, [id])
}

// ─── Enrollment Dependents ───────────────────────────────────────────────────

export async function linkEnrollmentDependent(q: Q, enrollmentId: string, dependentId: string): Promise<void> {
  const id = newId()
  await q.exec(
    `INSERT INTO enrollment_dependents (id, tenant_id, enrollment_id, dependent_id)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3)
     ON CONFLICT (enrollment_id, dependent_id) DO NOTHING`,
    [id, enrollmentId, dependentId],
  )
}

export async function listEnrollmentDependents(q: Q, enrollmentId: string): Promise<BenefitDependent[]> {
  const res = await q.query<BenefitDependent>(
    `SELECT d.id, d.tenant_id AS "tenantId", d.employee_id AS "employeeId",
            d.first_name AS "firstName", d.last_name AS "lastName", d.relationship,
            d.date_of_birth AS "dateOfBirth", d.ssn_enc AS "ssnEnc",
            d.is_active AS "isActive", d.created_at AS "createdAt", d.updated_at AS "updatedAt"
     FROM benefit_dependents d
     JOIN enrollment_dependents ed ON ed.dependent_id = d.id
     WHERE ed.enrollment_id = $1
     ORDER BY d.last_name, d.first_name`,
    [enrollmentId],
  )
  return res.rows
}

export async function unlinkEnrollmentDependent(q: Q, enrollmentId: string, dependentId: string): Promise<void> {
  await q.exec(`DELETE FROM enrollment_dependents WHERE enrollment_id = $1 AND dependent_id = $2`, [enrollmentId, dependentId])
}

// ─── Life Events ─────────────────────────────────────────────────────────────

export async function listLifeEvents(
  q: Q,
  opts: { employeeId?: string } = {},
): Promise<LifeEvent[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.employeeId) { params.push(opts.employeeId); conditions.push(`employee_id = $${params.length}`) }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const res = await q.query<LifeEvent>(`SELECT ${LIFE_EVENT_COLS} FROM life_events ${where} ORDER BY reported_at DESC`, params)
  return res.rows
}

export async function getLifeEvent(q: Q, id: string): Promise<LifeEvent | null> {
  const res = await q.query<LifeEvent>(`SELECT ${LIFE_EVENT_COLS} FROM life_events WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

export async function createLifeEvent(
  q: Q,
  opts: {
    employeeId: string
    eventType: string
    eventDate: string
    description?: string
  },
): Promise<LifeEvent> {
  const id = newId()
  await q.exec(
    `INSERT INTO life_events
       (id, tenant_id, employee_id, event_type, event_date, description)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4, $5)`,
    [id, opts.employeeId, opts.eventType, opts.eventDate, opts.description ?? null],
  )
  return (await getLifeEvent(q, id))!
}

export async function acknowledgeLifeEvent(q: Q, id: string, acknowledgedBy: string): Promise<void> {
  await q.exec(
    `UPDATE life_events SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1`,
    [id, acknowledgedBy],
  )
}

// ─── Employee Elections (for /benefits/my-elections) ─────────────────────────

export async function getMyElections(
  q: Q,
  employeeId: string,
): Promise<{
  enrollments: BenefitEnrollment[]
  dependents: BenefitDependent[]
  lifeEvents: LifeEvent[]
}> {
  const [enrollments, dependents, lifeEvents] = await Promise.all([
    q.query<BenefitEnrollment>(
      `SELECT ${ENROLLMENT_COLS} FROM benefit_enrollments WHERE employee_id = $1 ORDER BY created_at DESC`,
      [employeeId],
    ),
    q.query<BenefitDependent>(
      `SELECT ${DEPENDENT_COLS} FROM benefit_dependents WHERE employee_id = $1 ORDER BY last_name, first_name`,
      [employeeId],
    ),
    q.query<LifeEvent>(
      `SELECT ${LIFE_EVENT_COLS} FROM life_events WHERE employee_id = $1 ORDER BY reported_at DESC`,
      [employeeId],
    ),
  ])
  return {
    enrollments: enrollments.rows,
    dependents: dependents.rows,
    lifeEvents: lifeEvents.rows,
  }
}
