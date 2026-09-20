import type { Q } from '../../db/index.js'
import { newId } from '../../db/index.js'

export const PLAN_KINDS = ['onboarding', 'offboarding'] as const
export const PLAN_STATUSES = ['in_progress', 'completed', 'cancelled'] as const
export const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'] as const

export const TEMPLATE_TASK_CATEGORIES = [
  'it_provisioning',
  'paperwork',
  'training',
  'access',
  'asset',
  'exit_interview',
  'settlement',
  'general',
] as const

// ----------------------------------------------------------------------------
// Templates
// ----------------------------------------------------------------------------

export interface TemplateTask {
  id: string
  name: string
  category: string
  position: number
  optional: boolean
}

export interface OnboardingTemplate {
  id: string
  name: string
  kind: string
  description: string | null
  isDefault: boolean
  isActive: boolean
  taskCount: number
  createdAt: string
  updatedAt: string
}

export interface OnboardingTemplateDetail extends OnboardingTemplate {
  tasks: TemplateTask[]
}

const TEMPLATE_COLS = `
  t.id, t.name, t.kind, t.description,
  t.is_default AS "isDefault", t.is_active AS "isActive",
  (SELECT count(*)::int FROM onboarding_template_tasks tt WHERE tt.template_id = t.id) AS "taskCount",
  t.created_at::text AS "createdAt", t.updated_at::text AS "updatedAt"`

export interface TemplateFilter {
  kind?: 'onboarding' | 'offboarding'
  /** Restrict to the record most likely to be used as a default (admin console). */
  defaultOnly?: boolean
  includeInactive?: boolean
}

export async function listTemplates(
  q: Q,
  filter: TemplateFilter,
  page: number,
  pageSize: number,
): Promise<{ data: OnboardingTemplate[]; total: number }> {
  const conds = [`t.deleted_at IS NULL`]
  const params: unknown[] = []
  const push = (sql: string, value: unknown) => {
    params.push(value)
    conds.push(sql.replace('?', `$${params.length}`))
  }
  if (filter.kind) push(`t.kind = ?`, filter.kind)
  if (!filter.includeInactive) conds.push(`t.is_active = true`)
  if (filter.defaultOnly) conds.push(`t.is_default = true`)
  const where = `WHERE ${conds.join(' AND ')}`

  const total = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM onboarding_templates t ${where}`, params)
  const offset = (page - 1) * pageSize
  const rows = await q.query<OnboardingTemplate>(
    `SELECT ${TEMPLATE_COLS} FROM onboarding_templates t ${where}
     ORDER BY t.kind, t.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  )
  return { data: rows.rows, total: total.rows[0]?.n ?? 0 }
}

export async function getTemplate(q: Q, id: string): Promise<OnboardingTemplateDetail | null> {
  const res = await q.query<OnboardingTemplate>(
    `SELECT ${TEMPLATE_COLS} FROM onboarding_templates t WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [id],
  )
  const template = res.rows[0]
  if (!template) return null
  const tasks = await q.query<TemplateTask>(
    `SELECT id, name, category, position, optional
     FROM onboarding_template_tasks
     WHERE template_id = $1
     ORDER BY position, created_at`,
    [id],
  )
  return { ...template, tasks: tasks.rows }
}

export interface TemplateTaskInput {
  name: string
  category: string
  position?: number
  optional?: boolean
}

export interface TemplateInput {
  id: string
  tenantId: string
  name: string
  kind: 'onboarding' | 'offboarding'
  description?: string | null
  isDefault?: boolean
  createdBy: string | null
  tasks: TemplateTaskInput[]
}

export async function createTemplate(q: Q, input: TemplateInput): Promise<OnboardingTemplateDetail> {
  await q.exec(
    `INSERT INTO onboarding_templates
       (id, tenant_id, name, kind, description, is_default, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id,
      input.tenantId,
      input.name,
      input.kind,
      input.description ?? null,
      input.isDefault ?? false,
      input.createdBy,
    ],
  )
  for (const [i, task] of input.tasks.entries()) {
    await q.exec(
      `INSERT INTO onboarding_template_tasks
         (id, tenant_id, template_id, name, category, position, optional)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId(), input.tenantId, input.id, task.name, task.category, task.position ?? i, task.optional ?? false],
    )
  }
  const created = await getTemplate(q, input.id)
  if (!created) throw new Error('INSERT_CONFLICT_TEMPLATE')
  return created
}

const TEMPLATE_EDITABLE: Record<string, string> = {
  name: 'name',
  description: 'description',
  kind: 'kind',
  isDefault: 'is_default',
  isActive: 'is_active',
}

export async function updateTemplateFields(
  q: Q,
  id: string,
  fields: Record<string, unknown>,
): Promise<OnboardingTemplateDetail | null> {
  const entries = Object.entries(fields).filter(([key]) => key in TEMPLATE_EDITABLE)
  if (entries.length === 0) return getTemplate(q, id)
  const sets = entries.map(([key], i) => `"${TEMPLATE_EDITABLE[key]}" = $${i + 1}`)
  await q.exec(`UPDATE onboarding_templates SET ${sets.join(', ')}, updated_at = now() WHERE id = $${entries.length + 1}`, [
    ...entries.map(([, v]) => v),
    id,
  ])
  return getTemplate(q, id)
}

export async function softDeleteTemplate(q: Q, id: string): Promise<void> {
  await q.exec(`UPDATE onboarding_templates SET deleted_at = now(), is_active = false, updated_at = now() WHERE id = $1`, [id])
}

export async function addTemplateTask(
  q: Q,
  templateId: string,
  tenantId: string,
  input: TemplateTaskInput & { position?: number },
): Promise<TemplateTask> {
  const position = input.position ?? 0
  await q.exec(
    `INSERT INTO onboarding_template_tasks
       (id, tenant_id, template_id, name, category, position, optional)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [newId(), tenantId, templateId, input.name, input.category, position, input.optional ?? false],
  )
  const res = await q.query<TemplateTask>(
    `SELECT id, name, category, position, optional
     FROM onboarding_template_tasks
     WHERE template_id = $1 ORDER BY position, created_at DESC LIMIT 1`,
    [templateId],
  )
  return res.rows[0]!
}

export async function updateTemplateTask(
  q: Q,
  templateId: string,
  taskId: string,
  fields: Record<string, unknown>,
): Promise<TemplateTask | null> {
  const editable: Record<string, string> = { name: 'name', category: 'category', position: 'position', optional: 'optional' }
  const entries = Object.entries(fields).filter(([key]) => key in editable)
  if (entries.length === 0) {
    const res = await q.query<TemplateTask>(
      `SELECT id, name, category, position, optional FROM onboarding_template_tasks WHERE id = $1`,
      [taskId],
    )
    return res.rows[0] ?? null
  }
  const sets = entries.map(([key], i) => `"${editable[key]}" = $${i + 1}`)
  await q.exec(
    `UPDATE onboarding_template_tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $${entries.length + 1} AND template_id = $${entries.length + 2}`,
    [...entries.map(([, v]) => v), taskId, templateId],
  )
  const res = await q.query<TemplateTask>(
    `SELECT id, name, category, position, optional FROM onboarding_template_tasks WHERE id = $1`,
    [taskId],
  )
  return res.rows[0] ?? null
}

export async function removeTemplateTask(q: Q, templateId: string, taskId: string): Promise<void> {
  await q.exec(`DELETE FROM onboarding_template_tasks WHERE id = $1 AND template_id = $2`, [taskId, templateId])
}

// ----------------------------------------------------------------------------
// Plans (snapshot of a template's tasks)
// ----------------------------------------------------------------------------

export interface PlanTask {
  id: string
  name: string
  category: string
  position: number
  optional: boolean
  status: string
  notes: string | null
  completedBy: string | null
  completedAt: string | null
}

export interface OnboardingPlan {
  id: string
  employeeId: string
  employeeName: string | null
  kind: string
  templateId: string
  templateName: string
  status: string
  source: string
  startedAt: string
  completedAt: string | null
  totalTasks: number
  completedTasks: number
  progressPercent: number
}

export interface OnboardingPlanDetail extends OnboardingPlan {
  tasks: PlanTask[]
}

const PLAN_COLS = `
  p.id, p.employee_id AS "employeeId",
  concat_ws(' ', emp.first_name, emp.last_name) AS "employeeName",
  p.kind, p.template_id AS "templateId", tpl.name AS "templateName",
  p.status, p.source,
  p.started_at::text AS "startedAt", p.completed_at::text AS "completedAt",
  (SELECT count(*)::int FROM onboarding_tasks ot WHERE ot.plan_id = p.id) AS "totalTasks",
  (SELECT count(*)::int FROM onboarding_tasks ot WHERE ot.plan_id = p.id AND ot.status = 'completed') AS "completedTasks"`

export interface PlanFilter {
  kind?: string
  status?: string
  employeeId?: string
}

export async function listPlans(
  q: Q,
  filter: PlanFilter,
  page: number,
  pageSize: number,
): Promise<{ data: OnboardingPlan[]; total: number }> {
  const conds: string[] = []
  const params: unknown[] = []
  const push = (sql: string, value: unknown) => {
    params.push(value)
    conds.push(sql.replace('?', `$${params.length}`))
  }
  if (filter.kind) push(`p.kind = ?`, filter.kind)
  if (filter.status) push(`p.status = ?`, filter.status)
  if (filter.employeeId) push(`p.employee_id = ?`, filter.employeeId)
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  const total = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM onboarding_plans p ${where}`, params)
  const offset = (page - 1) * pageSize
  const rows = await q.query<OnboardingPlan>(
    `SELECT ${PLAN_COLS}
     FROM onboarding_plans p
     JOIN employees emp ON emp.id = p.employee_id
     JOIN onboarding_templates tpl ON tpl.id = p.template_id
     ${where}
     ORDER BY p.started_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  )
  const data = rows.rows.map((r) => ({ ...r, progressPercent: planProgress(r.completedTasks, r.totalTasks) }))
  return { data, total: total.rows[0]?.n ?? 0 }
}

function planProgress(completedTasks: number, totalTasks: number): number {
  if (totalTasks === 0) return 100
  return Math.round((completedTasks / totalTasks) * 100)
}

export async function getPlan(q: Q, id: string): Promise<OnboardingPlanDetail | null> {
  const res = await q.query<OnboardingPlan>(
    `SELECT ${PLAN_COLS}
     FROM onboarding_plans p
     JOIN employees emp ON emp.id = p.employee_id
     JOIN onboarding_templates tpl ON tpl.id = p.template_id
     WHERE p.id = $1`,
    [id],
  )
  const plan = res.rows[0]
  if (!plan) return null
  const tasks = await q.query<PlanTask>(
    `SELECT id, name, category, position, optional, status, notes,
            completed_by AS "completedBy", completed_at::text AS "completedAt"
     FROM onboarding_tasks
     WHERE plan_id = $1
     ORDER BY position, created_at`,
    [id],
  )
  return { ...plan, progressPercent: planProgress(plan.completedTasks, plan.totalTasks), tasks: tasks.rows }
}

export interface PlanInput {
  id: string
  tenantId: string
  employeeId: string
  kind: 'onboarding' | 'offboarding'
  templateId: string
  source: 'manual' | 'system'
  createdBy: string | null
}

/**
 * Starts a plan for an employee, snapshotting the template's current tasks.
 * A plan with only terminal tasks auto-completes (e.g. an empty checklist).
 * Runs inside the caller's tenant transaction (also used by the ATS hire flow).
 */
export async function startPlan(q: Q, input: PlanInput): Promise<OnboardingPlanDetail> {
  await q.exec(
    `INSERT INTO onboarding_plans
       (id, tenant_id, employee_id, kind, template_id, status, source, created_by)
     VALUES ($1, $2, $3, $4, $5, 'in_progress', $6, $7)`,
    [input.id, input.tenantId, input.employeeId, input.kind, input.templateId, input.source, input.createdBy],
  )
  await q.exec(
    `INSERT INTO onboarding_tasks (id, tenant_id, plan_id, name, category, position, optional)
     SELECT gen_random_uuid(), $1, $2, name, category, position, optional
     FROM onboarding_template_tasks
     WHERE template_id = $3`,
    [input.tenantId, input.id, input.templateId],
  )
  await maybeCompletePlan(q, input.tenantId, input.id)
  const plan = await getPlan(q, input.id)
  if (!plan) throw new Error('INSERT_CONFLICT_PLAN')
  return plan
}

/** The active default template for a kind, if any (used by the hire flow). */
export async function getDefaultTemplate(
  q: Q,
  tenantId: string,
  kind: 'onboarding' | 'offboarding',
): Promise<OnboardingTemplateDetail | null> {
  const res = await q.query<OnboardingTemplate>(
    `SELECT ${TEMPLATE_COLS}
     FROM onboarding_templates t
     WHERE t.tenant_id = $1 AND t.kind = $2 AND t.is_active = true AND t.is_default = true AND t.deleted_at IS NULL
     ORDER BY t.created_at ASC
     LIMIT 1`,
    [tenantId, kind],
  )
  const template = res.rows[0]
  if (!template) return null
  const tasks = await q.query<TemplateTask>(
    `SELECT id, name, category, position, optional
     FROM onboarding_template_tasks WHERE template_id = $1 ORDER BY position, created_at`,
    [template.id],
  )
  return { ...template, tasks: tasks.rows }
}

/** Sets the plan status to completed when every task is in a terminal state. */
export async function maybeCompletePlan(q: Q, tenantId: string, planId: string): Promise<void> {
  await q.exec(
    `UPDATE onboarding_plans p SET status = 'completed', completed_at = now(), updated_at = now()
     WHERE p.id = $1 AND p.tenant_id = $2
       AND p.status = 'in_progress'
       AND NOT EXISTS (
         SELECT 1 FROM onboarding_tasks ot
         WHERE ot.plan_id = p.id AND ot.status NOT IN ('completed', 'skipped')
       )`,
    [planId, tenantId],
  )
}

export async function cancelPlan(q: Q, id: string, tenantId: string): Promise<OnboardingPlan | null> {
  await q.exec(
    `UPDATE onboarding_plans SET status = 'cancelled', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  )
  const plan = await getPlan(q, id)
  return plan
}

/**
 * Updates a plan task's status (and optional notes). Plan-level guardrails:
 *  - only in_progress plans accept task updates (completed/cancelled are final)
 *  - applying the change then auto-completes the plan when all tasks are done.
 */
export async function updatePlanTask(
  q: Q,
  tenantId: string,
  planId: string,
  taskId: string,
  input: { status: string; notes?: string | null; completedBy: string | null },
): Promise<PlanTask | null> {
  const status = input.status
  const willTerminal = status === 'completed' || status === 'skipped'
  await q.exec(
    `UPDATE onboarding_tasks
     SET status = $1, notes = COALESCE($2, notes),
         completed_by = $3, completed_at = CASE WHEN $4 THEN now() ELSE completed_at END,
         updated_at = now()
     WHERE id = $5 AND plan_id = $6`,
    [status, input.notes ?? null, willTerminal ? input.completedBy : null, willTerminal, taskId, planId],
  )
  const res = await q.query<PlanTask>(
    `SELECT id, name, category, position, optional, status, notes,
            completed_by AS "completedBy", completed_at::text AS "completedAt"
     FROM onboarding_tasks WHERE id = $1`,
    [taskId],
  )
  const task = res.rows[0] ?? null
  await maybeCompletePlan(q, tenantId, planId)
  return task
}

/** Any active plan for an employee/kind that is still in progress (prevents
 *  unbounded auto-start piles when re-seeding the ATS demo data). */
export async function countInProgressPlans(q: Q, tenantId: string, employeeId: string, kind: string): Promise<number> {
  const res = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM onboarding_plans
     WHERE tenant_id = $1 AND employee_id = $2 AND kind = $3 AND status = 'in_progress'`,
    [tenantId, employeeId, kind],
  )
  return res.rows[0]?.n ?? 0
}