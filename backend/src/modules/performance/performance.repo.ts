/**
 * Performance repository. Query helpers for goals, review cycles,
 * performance reviews, and feedback entries.
 * All queries run within tenant-scoped transactions.
 */

import type { Q } from '../../db/index.js'
import { newId } from '../../db/index.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Goal {
  id: string
  tenantId: string
  employeeId: string
  title: string
  description: string | null
  category: string | null
  goalType: string
  targetValue: number | null
  currentValue: number
  percentage: number
  status: string
  dueDate: string | null
  completedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface ReviewCycle {
  id: string
  tenantId: string
  name: string
  description: string | null
  status: string
  startsAt: string
  endsAt: string
  reviewDeadline: string | null
  finalizedBy: string | null
  finalizedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface CycleGoal {
  id: string
  tenantId: string
  cycleId: string
  goalId: string
  mappedAt: string
}

export interface PerformanceReview {
  id: string
  tenantId: string
  cycleId: string
  employeeId: string
  selfRating: number | null
  selfComment: string | null
  selfSubmittedAt: string | null
  managerId: string | null
  managerRating: number | null
  managerComment: string | null
  managerSubmittedAt: string | null
  finalRating: number | null
  finalizedBy: string | null
  finalizedAt: string | null
  status: string
  createdAt: string
  updatedAt: string
}

export interface FeedbackEntry {
  id: string
  tenantId: string
  authorId: string
  recipientId: string
  cycleId: string | null
  content: string
  feedbackType: string
  isAnonymous: boolean
  createdAt: string
}

// ─── Column Aliases ──────────────────────────────────────────────────────────

const GOAL_COLS = `id, tenant_id AS "tenantId", employee_id AS "employeeId",
  title, description, category, goal_type AS "goalType",
  target_value AS "targetValue", current_value AS "currentValue",
  percentage, status, due_date AS "dueDate", completed_at AS "completedAt",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`

const CYCLE_COLS = `id, tenant_id AS "tenantId", name, description, status,
  starts_at AS "startsAt", ends_at AS "endsAt", review_deadline AS "reviewDeadline",
  finalized_by AS "finalizedBy", finalized_at AS "finalizedAt",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`

const REVIEW_COLS = `id, tenant_id AS "tenantId", cycle_id AS "cycleId", employee_id AS "employeeId",
  self_rating AS "selfRating", self_comment AS "selfComment", self_submitted_at AS "selfSubmittedAt",
  manager_id AS "managerId", manager_rating AS "managerRating", manager_comment AS "managerComment",
  manager_submitted_at AS "managerSubmittedAt",
  final_rating AS "finalRating", finalized_by AS "finalizedBy", finalized_at AS "finalizedAt",
  status, created_at AS "createdAt", updated_at AS "updatedAt"`

const FEEDBACK_COLS = `id, tenant_id AS "tenantId", author_id AS "authorId",
  recipient_id AS "recipientId", cycle_id AS "cycleId",
  content, feedback_type AS "feedbackType", is_anonymous AS "isAnonymous",
  created_at AS "createdAt"`

// ─── Goals ───────────────────────────────────────────────────────────────────

export async function listGoals(
  q: Q,
  opts: { employeeId?: string; managerEmployeeId?: string; page?: number; pageSize?: number } = {},
): Promise<{ data: Goal[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25))
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.employeeId) {
    params.push(opts.employeeId)
    conditions.push(`employee_id = $${params.length}`)
  } else if (opts.managerEmployeeId) {
    params.push(opts.managerEmployeeId)
    conditions.push(`employee_id IN (SELECT id FROM employees WHERE manager_employee_id = $${params.length})`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  params.push(pageSize, (page - 1) * pageSize)

  const [dataRes, countRes] = await Promise.all([
    q.query<Goal>(
      `SELECT ${GOAL_COLS} FROM goals ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    q.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM goals ${where}`,
      params.slice(0, -2),
    ),
  ])

  return { data: dataRes.rows, total: countRes.rows[0]?.count ?? 0 }
}

export async function getGoal(q: Q, id: string): Promise<Goal | null> {
  const res = await q.query<Goal>(`SELECT ${GOAL_COLS} FROM goals WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

export async function createGoal(
  q: Q,
  opts: {
    employeeId: string
    title: string
    description?: string
    category?: string
    goalType?: string
    targetValue?: number
    percentage?: number
    dueDate?: string
    createdBy: string
  },
): Promise<Goal> {
  const id = newId()
  await q.exec(
    `INSERT INTO goals (id, tenant_id, employee_id, title, description, category, goal_type, target_value, percentage, due_date, created_by)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, opts.employeeId, opts.title, opts.description ?? null, opts.category ?? null,
     opts.goalType ?? 'okr', opts.targetValue ?? null, opts.percentage ?? 0, opts.dueDate ?? null, opts.createdBy],
  )
  return (await getGoal(q, id))!
}

export async function updateGoal(
  q: Q,
  id: string,
  fields: {
    title?: string
    description?: string
    category?: string
    percentage?: number
    currentValue?: number
    targetValue?: number
    status?: string
  },
): Promise<void> {
  const sets: string[] = ['updated_at = now()']
  const params: unknown[] = [id]
  if (fields.title !== undefined) { params.push(fields.title); sets.push(`title = $${params.length}`) }
  if (fields.description !== undefined) { params.push(fields.description); sets.push(`description = $${params.length}`) }
  if (fields.category !== undefined) { params.push(fields.category); sets.push(`category = $${params.length}`) }
  if (fields.percentage !== undefined) { params.push(fields.percentage); sets.push(`percentage = $${params.length}`) }
  if (fields.currentValue !== undefined) { params.push(fields.currentValue); sets.push(`current_value = $${params.length}`) }
  if (fields.targetValue !== undefined) { params.push(fields.targetValue); sets.push(`target_value = $${params.length}`) }
  if (fields.status !== undefined) {
    params.push(fields.status)
    sets.push(`status = $${params.length}`)
    if (fields.status === 'completed') sets.push(`completed_at = now()`)
  }
  await q.exec(`UPDATE goals SET ${sets.join(', ')} WHERE id = $1`, params)
}

// ─── Review Cycles ───────────────────────────────────────────────────────────

export async function listReviewCycles(
  q: Q,
  opts: { status?: string; page?: number; pageSize?: number } = {},
): Promise<{ data: ReviewCycle[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25))
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.status) {
    params.push(opts.status)
    conditions.push(`status = $${params.length}`)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  params.push(pageSize, (page - 1) * pageSize)

  const [dataRes, countRes] = await Promise.all([
    q.query<ReviewCycle>(
      `SELECT ${CYCLE_COLS} FROM review_cycles ${where} ORDER BY starts_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    q.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM review_cycles ${where}`,
      params.slice(0, -2),
    ),
  ])

  return { data: dataRes.rows, total: countRes.rows[0]?.count ?? 0 }
}

export async function getReviewCycle(q: Q, id: string): Promise<ReviewCycle | null> {
  const res = await q.query<ReviewCycle>(`SELECT ${CYCLE_COLS} FROM review_cycles WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

export async function createReviewCycle(
  q: Q,
  opts: {
    name: string
    description?: string
    startsAt: string
    endsAt: string
    reviewDeadline?: string
    createdBy: string
  },
): Promise<ReviewCycle> {
  const id = newId()
  await q.exec(
    `INSERT INTO review_cycles (id, tenant_id, name, description, starts_at, ends_at, review_deadline, created_by)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4, $5, $6, $7)`,
    [id, opts.name, opts.description ?? null, opts.startsAt, opts.endsAt, opts.reviewDeadline ?? null, opts.createdBy],
  )
  return (await getReviewCycle(q, id))!
}

export async function updateReviewCycleStatus(
  q: Q,
  id: string,
  status: string,
  extra?: { finalizedBy?: string },
): Promise<void> {
  const sets = ['status = $2', 'updated_at = now()']
  const params: unknown[] = [id, status]
  if (extra?.finalizedBy) {
    params.push(extra.finalizedBy)
    sets.push(`finalized_by = $${params.length}`, `finalized_at = now()`)
  }
  await q.exec(`UPDATE review_cycles SET ${sets.join(', ')} WHERE id = $1`, params)
}

// ─── Cycle Goals ─────────────────────────────────────────────────────────────

export async function mapGoalToCycle(q: Q, cycleId: string, goalId: string): Promise<CycleGoal | null> {
  const id = newId()
  await q.exec(
    `INSERT INTO cycle_goals (id, tenant_id, cycle_id, goal_id)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3)
     ON CONFLICT (cycle_id, goal_id) DO NOTHING`,
    [id, cycleId, goalId],
  )
  const res = await q.query<CycleGoal>(`SELECT id, tenant_id AS "tenantId", cycle_id AS "cycleId", goal_id AS "goalId", mapped_at AS "mappedAt" FROM cycle_goals WHERE cycle_id = $1 AND goal_id = $2`, [cycleId, goalId])
  return res.rows[0] ?? null
}

export async function listCycleGoals(q: Q, cycleId: string): Promise<Goal[]> {
  const res = await q.query<Goal>(
    `SELECT g.id, g.tenant_id AS "tenantId", g.employee_id AS "employeeId",
       g.title, g.description, g.category, g.goal_type AS "goalType",
       g.target_value AS "targetValue", g.current_value AS "currentValue",
       g.percentage, g.status, g.due_date AS "dueDate", g.completed_at AS "completedAt",
       g.created_by AS "createdBy", g.created_at AS "createdAt", g.updated_at AS "updatedAt"
     FROM goals g
     JOIN cycle_goals cg ON cg.goal_id = g.id
     WHERE cg.cycle_id = $1
     ORDER BY g.created_at DESC`,
    [cycleId],
  )
  return res.rows
}

// ─── Performance Reviews ─────────────────────────────────────────────────────

export async function listPerformanceReviews(
  q: Q,
  opts: { cycleId?: string; employeeId?: string; managerEmployeeId?: string; page?: number; pageSize?: number } = {},
): Promise<{ data: PerformanceReview[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25))
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.cycleId) {
    params.push(opts.cycleId)
    conditions.push(`cycle_id = $${params.length}`)
  }
  if (opts.employeeId) {
    params.push(opts.employeeId)
    conditions.push(`employee_id = $${params.length}`)
  } else if (opts.managerEmployeeId) {
    params.push(opts.managerEmployeeId)
    conditions.push(`employee_id IN (SELECT id FROM employees WHERE manager_employee_id = $${params.length})`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  params.push(pageSize, (page - 1) * pageSize)

  const [dataRes, countRes] = await Promise.all([
    q.query<PerformanceReview>(
      `SELECT ${REVIEW_COLS} FROM performance_reviews ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    q.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM performance_reviews ${where}`,
      params.slice(0, -2),
    ),
  ])

  return { data: dataRes.rows, total: countRes.rows[0]?.count ?? 0 }
}

export async function getPerformanceReview(q: Q, id: string): Promise<PerformanceReview | null> {
  const res = await q.query<PerformanceReview>(`SELECT ${REVIEW_COLS} FROM performance_reviews WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

export async function getPerformanceReviewByCycleAndEmployee(
  q: Q,
  cycleId: string,
  employeeId: string,
): Promise<PerformanceReview | null> {
  const res = await q.query<PerformanceReview>(
    `SELECT ${REVIEW_COLS} FROM performance_reviews WHERE cycle_id = $1 AND employee_id = $2`,
    [cycleId, employeeId],
  )
  return res.rows[0] ?? null
}

export async function createPerformanceReview(
  q: Q,
  opts: { cycleId: string; employeeId: string; managerId?: string },
): Promise<PerformanceReview> {
  const id = newId()
  await q.exec(
    `INSERT INTO performance_reviews (id, tenant_id, cycle_id, employee_id, manager_id)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4)
     ON CONFLICT (cycle_id, employee_id) DO NOTHING`,
    [id, opts.cycleId, opts.employeeId, opts.managerId ?? null],
  )
  return (await getPerformanceReview(q, id))!
}

export async function submitSelfReview(
  q: Q,
  id: string,
  rating: number,
  comment: string,
): Promise<void> {
  await q.exec(
    `UPDATE performance_reviews
     SET self_rating = $2, self_comment = $3, self_submitted_at = now(),
         status = 'self_submitted', updated_at = now()
     WHERE id = $1`,
    [id, rating, comment],
  )
}

export async function submitManagerReview(
  q: Q,
  id: string,
  managerId: string,
  rating: number,
  comment: string,
): Promise<void> {
  await q.exec(
    `UPDATE performance_reviews
     SET manager_id = $2, manager_rating = $3, manager_comment = $4, manager_submitted_at = now(),
         status = 'manager_reviewing', updated_at = now()
     WHERE id = $1`,
    [id, managerId, rating, comment],
  )
}

export async function finalizeReview(
  q: Q,
  id: string,
  finalRating: number,
  finalizedBy: string,
): Promise<void> {
  await q.exec(
    `UPDATE performance_reviews
     SET final_rating = $2, finalized_by = $3, finalized_at = now(),
         status = 'finalized', updated_at = now()
     WHERE id = $1`,
    [id, finalRating, finalizedBy],
  )
}

// ─── Feedback Entries ────────────────────────────────────────────────────────

export async function listFeedbackEntries(
  q: Q,
  opts: { authorId?: string; recipientId?: string; managerEmployeeId?: string; page?: number; pageSize?: number } = {},
): Promise<{ data: FeedbackEntry[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25))
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.authorId) {
    params.push(opts.authorId)
    conditions.push(`author_id = $${params.length}`)
  }
  if (opts.recipientId) {
    params.push(opts.recipientId)
    conditions.push(`recipient_id = $${params.length}`)
  } else if (opts.managerEmployeeId) {
    params.push(opts.managerEmployeeId)
    conditions.push(`(author_id = $${params.length} OR recipient_id = $${params.length})`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  params.push(pageSize, (page - 1) * pageSize)

  const [dataRes, countRes] = await Promise.all([
    q.query<FeedbackEntry>(
      `SELECT ${FEEDBACK_COLS} FROM feedback_entries ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    q.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM feedback_entries ${where}`,
      params.slice(0, -2),
    ),
  ])

  return { data: dataRes.rows, total: countRes.rows[0]?.count ?? 0 }
}

export async function createFeedbackEntry(
  q: Q,
  opts: {
    authorId: string
    recipientId: string
    cycleId?: string | null
    content: string
    feedbackType?: string
  },
): Promise<FeedbackEntry> {
  const id = newId()
  await q.exec(
    `INSERT INTO feedback_entries (id, tenant_id, author_id, recipient_id, cycle_id, content, feedback_type)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4, $5, $6)`,
    [id, opts.authorId, opts.recipientId, opts.cycleId ?? null, opts.content, opts.feedbackType ?? 'general'],
  )
  const res = await q.query<FeedbackEntry>(`SELECT ${FEEDBACK_COLS} FROM feedback_entries WHERE id = $1`, [id])
  return res.rows[0]!
}

// ─── /performance/me aggregates ──────────────────────────────────────────────

export async function getMyPerformanceData(
  q: Q,
  employeeId: string,
): Promise<{ goals: Goal[]; reviews: PerformanceReview[]; feedback: FeedbackEntry[] }> {
  const [goalsRes, reviewsRes, feedbackRes] = await Promise.all([
    q.query<Goal>(
      `SELECT ${GOAL_COLS} FROM goals WHERE employee_id = $1 ORDER BY created_at DESC`,
      [employeeId],
    ),
    q.query<PerformanceReview>(
      `SELECT ${REVIEW_COLS} FROM performance_reviews WHERE employee_id = $1 ORDER BY created_at DESC`,
      [employeeId],
    ),
    q.query<FeedbackEntry>(
      `SELECT ${FEEDBACK_COLS} FROM feedback_entries WHERE author_id = $1 OR recipient_id = $1 ORDER BY created_at DESC`,
      [employeeId],
    ),
  ])
  return {
    goals: goalsRes.rows,
    reviews: reviewsRes.rows,
    feedback: feedbackRes.rows,
  }
}
