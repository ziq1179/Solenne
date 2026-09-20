import type { Q } from '../../db/index.js'

export interface JobOpening {
  id: string
  title: string
  departmentId: string | null
  departmentName: string | null
  locationId: string | null
  locationName: string | null
  employmentType: string
  salaryMin: string | null
  salaryMax: string | null
  currency: string
  description: string | null
  requirements: string | null
  headcount: number
  status: string
  createdAt: string
  updatedAt: string
}

export const JOB_STATUSES = ['draft', 'pending_approval', 'open', 'on_hold', 'closed'] as const

const JOB_COLS = `
  j.id, j.title,
  j.department_id AS "departmentId", d.name AS "departmentName",
  j.location_id AS "locationId", l.name AS "locationName",
  j.employment_type AS "employmentType",
  j.salary_min::text AS "salaryMin", j.salary_max::text AS "salaryMax", j.currency,
  j.description, j.requirements, j.headcount,
  j.status, j.created_at::text AS "createdAt", j.updated_at::text AS "updatedAt"`

const JOB_JOIN = `
  LEFT JOIN departments d ON d.id = j.department_id
  LEFT JOIN locations l ON l.id = j.location_id`

export interface JobFilter {
  status?: string
  departmentId?: string
}

export async function listJobOpenings(
  q: Q,
  filter: JobFilter,
  page: number,
  pageSize: number,
): Promise<{ data: JobOpening[]; total: number }> {
  const conds = [`j.deleted_at IS NULL`]
  const params: unknown[] = []
  if (filter.status) {
    params.push(filter.status)
    conds.push(`j.status = $${params.length}`)
  }
  if (filter.departmentId) {
    params.push(filter.departmentId)
    conds.push(`j.department_id = $${params.length}`)
  }
  const where = `WHERE ${conds.join(' AND ')}`
  const total = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM job_openings j ${where}`, params)
  const offset = (page - 1) * pageSize
  const rows = await q.query<JobOpening>(
    `SELECT ${JOB_COLS} FROM job_openings j ${JOB_JOIN} ${where}
     ORDER BY j.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  )
  return { data: rows.rows, total: total.rows[0]?.n ?? 0 }
}

export async function getJobOpening(q: Q, id: string): Promise<JobOpening | null> {
  const res = await q.query<JobOpening>(
    `SELECT ${JOB_COLS} FROM job_openings j ${JOB_JOIN}
     WHERE j.id = $1 AND j.deleted_at IS NULL`,
    [id],
  )
  return res.rows[0] ?? null
}

export interface JobOpeningInput {
  id: string
  tenantId: string
  title: string
  departmentId: string | null
  locationId: string | null
  employmentType: string
  salaryMin: number | null
  salaryMax: number | null
  currency: string
  description: string | null
  requirements: string | null
  headcount: number
  status: string
  createdBy: string | null
}

export async function insertJobOpening(q: Q, input: JobOpeningInput): Promise<JobOpening> {
  await q.exec(
    `INSERT INTO job_openings
       (id, tenant_id, title, department_id, location_id, employment_type,
        salary_min, salary_max, currency, description, requirements, headcount,
        status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      input.id,
      input.tenantId,
      input.title,
      input.departmentId,
      input.locationId,
      input.employmentType,
      input.salaryMin,
      input.salaryMax,
      input.currency,
      input.description,
      input.requirements,
      input.headcount,
      input.status,
      input.createdBy,
    ],
  )
  const created = await getJobOpening(q, input.id)
  if (!created) throw new Error('INSERT_CONFLICT_JOB_OPENING')
  return created
}

const JOB_EDITABLE: Record<string, string> = {
  title: 'title',
  departmentId: 'department_id',
  locationId: 'location_id',
  employmentType: 'employment_type',
  salaryMin: 'salary_min',
  salaryMax: 'salary_max',
  currency: 'currency',
  description: 'description',
  requirements: 'requirements',
  headcount: 'headcount',
}

export async function updateJobOpeningFields(q: Q, id: string, fields: Record<string, unknown>): Promise<JobOpening | null> {
  const entries = Object.entries(fields).filter(([key]) => key in JOB_EDITABLE)
  if (entries.length === 0) return getJobOpening(q, id)
  const sets = entries.map(([key], i) => `"${JOB_EDITABLE[key]}" = $${i + 1}`)
  await q.exec(
    `UPDATE job_openings SET ${sets.join(', ')}, updated_at = now() WHERE id = $${entries.length + 1}`,
    [...entries.map(([, v]) => v), id],
  )
  return getJobOpening(q, id)
}

export async function updateJobOpeningStatus(q: Q, id: string, status: string): Promise<JobOpening | null> {
  await q.exec(`UPDATE job_openings SET status = $2, updated_at = now() WHERE id = $1`, [id, status])
  return getJobOpening(q, id)
}

export async function softDeleteJobOpening(q: Q, id: string): Promise<void> {
  await q.exec(`UPDATE job_openings SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id])
}

// ----------------------------------------------------------------------------

export interface Candidate {
  id: string
  jobOpeningId: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  resumeText: string | null
  source: string
  stage: string
  rating: number | null
  notes: string | null
  hiredEmployeeId: string | null
  createdAt: string
  updatedAt: string
}

export const PIPELINE_STAGES = ['sourced', 'applied', 'screening', 'interview', 'offer', 'hired', 'rejected'] as const
const TERMINAL = new Set(['hired', 'rejected'])

export function canTransition(from: string, to: string): { ok: boolean; message?: string } {
  if (from === to) return { ok: false, message: `Candidate is already ${to}` }
  if (TERMINAL.has(from)) return { ok: false, message: `A ${from} candidate cannot be moved` }
  if (to === 'hired' && from !== 'offer') return { ok: false, message: 'A candidate can only be hired from the offer stage' }
  if (!TERMINAL.has(to) && !PIPELINE_STAGES.some((s) => s === to)) {
    return { ok: false, message: 'Unknown pipeline stage' }
  }
  return { ok: true }
}

const CAN_COLS = `
  c.id, c.job_opening_id AS "jobOpeningId",
  c.first_name AS "firstName", c.last_name AS "lastName",
  c.email, c.phone, c.resume_text AS "resumeText", c.source, c.stage,
  c.rating, c.notes, c.hired_employee_id AS "hiredEmployeeId",
  c.created_at::text AS "createdAt", c.updated_at::text AS "updatedAt"`

export interface CandidateFilter {
  stage?: string
}

export async function listCandidates(
  q: Q,
  jobOpeningId: string,
  filter: CandidateFilter,
  page: number,
  pageSize: number,
): Promise<{ data: Candidate[]; total: number }> {
  const conds = [`c.job_opening_id = $1`, `c.deleted_at IS NULL`]
  const params: unknown[] = [jobOpeningId]
  if (filter.stage) {
    params.push(filter.stage)
    conds.push(`c.stage = $${params.length}`)
  }
  const where = `WHERE ${conds.join(' AND ')}`
  const total = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM job_candidates c ${where}`, params)
  const offset = (page - 1) * pageSize
  const rows = await q.query<Candidate>(
    `SELECT ${CAN_COLS} FROM job_candidates c ${where}
     ORDER BY c.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  )
  return { data: rows.rows, total: total.rows[0]?.n ?? 0 }
}

export async function getCandidate(q: Q, id: string): Promise<Candidate | null> {
  const res = await q.query<Candidate>(
    `SELECT ${CAN_COLS} FROM job_candidates c
     WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [id],
  )
  return res.rows[0] ?? null
}

export interface CandidateInput {
  id: string
  tenantId: string
  jobOpeningId: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  resumeText: string | null
  source: string
  stage: string
  rating: number | null
  notes: string | null
  createdBy: string | null
}

export async function insertCandidate(q: Q, input: CandidateInput): Promise<Candidate> {
  await q.exec(
    `INSERT INTO job_candidates
       (id, tenant_id, job_opening_id, first_name, last_name, email, phone,
        resume_text, source, stage, rating, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      input.id,
      input.tenantId,
      input.jobOpeningId,
      input.firstName,
      input.lastName,
      input.email,
      input.phone,
      input.resumeText,
      input.source,
      input.stage,
      input.rating,
      input.notes,
      input.createdBy,
    ],
  )
  const created = await getCandidate(q, input.id)
  if (!created) throw new Error('INSERT_CONFLICT_CANDIDATE')
  return created
}

const CAN_EDITABLE: Record<string, string> = {
  firstName: 'first_name',
  lastName: 'last_name',
  email: 'email',
  phone: 'phone',
  resumeText: 'resume_text',
  source: 'source',
  rating: 'rating',
  notes: 'notes',
}

export async function updateCandidateFields(q: Q, id: string, fields: Record<string, unknown>): Promise<Candidate | null> {
  const entries = Object.entries(fields).filter(([key]) => key in CAN_EDITABLE)
  if (entries.length === 0) return getCandidate(q, id)
  const sets = entries.map(([key], i) => `"${CAN_EDITABLE[key]}" = $${i + 1}`)
  await q.exec(
    `UPDATE job_candidates SET ${sets.join(', ')}, updated_at = now() WHERE id = $${entries.length + 1}`,
    [...entries.map(([, v]) => v), id],
  )
  return getCandidate(q, id)
}

export async function updateCandidateStage(q: Q, id: string, stage: string): Promise<Candidate | null> {
  await q.exec(`UPDATE job_candidates SET stage = $2, updated_at = now() WHERE id = $1`, [id, stage])
  return getCandidate(q, id)
}

export async function softDeleteCandidate(q: Q, id: string): Promise<void> {
  await q.exec(`UPDATE job_candidates SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id])
}