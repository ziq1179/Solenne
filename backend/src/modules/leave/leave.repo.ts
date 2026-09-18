import type { Q, Row } from '../../db/index.js'
import { newId } from '../../db/index.js'

export interface LeaveType {
  id: string
  name: string
  accrualDaysPerYear: number
  carryForwardMaxDays: number
  requiresApproval: boolean
}

export interface Balance {
  leaveTypeId: string
  year: number
  accruedDays: number
  usedDays: number
  carriedOverDays: number
  remainingDays: number
}

export interface LeaveRequest {
  id: string
  employeeId: string
  leaveTypeId: string
  startDate: string
  endDate: string
  daysRequested: number
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  reason: string | null
  submittedVia: 'web' | 'mobile' | 'ai_agent'
  createdAt: string
}

interface LeaveRequestRow extends Row {
  id: string
  employeeId: string
  leaveTypeId: string
  startDate: string
  endDate: string
  daysRequested: number
  status: LeaveRequest['status']
  reason: string | null
  submittedVia: LeaveRequest['submittedVia']
  createdAt: string
}

const REQUEST_COLS = `
  lr.id, lr.employee_id AS "employeeId", lr.leave_type_id AS "leaveTypeId",
  lr.start_date::text AS "startDate", lr.end_date::text AS "endDate",
  lr.days_requested::float8 AS "daysRequested", lr.status, lr.reason,
  lr.submitted_via AS "submittedVia", lr.created_at::text AS "createdAt"`

function mapRequest(r: LeaveRequestRow): LeaveRequest {
  return {
    id: r.id,
    employeeId: r.employeeId,
    leaveTypeId: r.leaveTypeId,
    startDate: r.startDate,
    endDate: r.endDate,
    daysRequested: r.daysRequested,
    status: r.status,
    reason: r.reason,
    submittedVia: r.submittedVia,
    createdAt: r.createdAt,
  }
}

export async function listLeaveTypes(q: Q): Promise<LeaveType[]> {
  const res = await q.query<Row>(
    `SELECT id, name,
            accrual_days_per_year::float8 AS "accrualDaysPerYear",
            carry_forward_max_days::float8 AS "carryForwardMaxDays",
            requires_approval AS "requiresApproval"
     FROM leave_types ORDER BY name`,
  )
  return res.rows as unknown as LeaveType[]
}

export async function getLeaveType(q: Q, id: string): Promise<LeaveType | null> {
  const res = await q.query<Row>(
    `SELECT id, name,
            accrual_days_per_year::float8 AS "accrualDaysPerYear",
            carry_forward_max_days::float8 AS "carryForwardMaxDays",
            requires_approval AS "requiresApproval"
     FROM leave_types WHERE id = $1`,
    [id],
  )
  return (res.rows[0] as unknown as LeaveType | undefined) ?? null
}

export async function getBalance(
  q: Q,
  employeeId: string,
  leaveTypeId: string,
  year: number,
): Promise<Balance | null> {
  const res = await q.query<Row>(
    `SELECT leave_type_id AS "leaveTypeId", year,
            accrued_days::float8 AS "accruedDays", used_days::float8 AS "usedDays",
            carried_over_days::float8 AS "carriedOverDays",
            (accrued_days + carried_over_days - used_days)::float8 AS "remainingDays"
     FROM leave_balances
     WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
    [employeeId, leaveTypeId, year],
  )
  return (res.rows[0] as unknown as Balance | undefined) ?? null
}

export async function listBalances(q: Q, employeeId: string, year: number): Promise<Balance[]> {
  const res = await q.query<Row>(
    `SELECT lb.leave_type_id AS "leaveTypeId", lb.year,
            lb.accrued_days::float8 AS "accruedDays", lb.used_days::float8 AS "usedDays",
            lb.carried_over_days::float8 AS "carriedOverDays",
            (lb.accrued_days + lb.carried_over_days - lb.used_days)::float8 AS "remainingDays"
     FROM leave_balances lb
     WHERE lb.employee_id = $1 AND lb.year = $2
     ORDER BY lb.leave_type_id`,
    [employeeId, year],
  )
  return res.rows as unknown as Balance[]
}

export async function incrementUsedDays(
  q: Q,
  employeeId: string,
  leaveTypeId: string,
  year: number,
  days: number,
): Promise<void> {
  await q.exec(
    `UPDATE leave_balances
     SET used_days = used_days + $1, updated_at = now()
     WHERE employee_id = $2 AND leave_type_id = $3 AND year = $4`,
    [days, employeeId, leaveTypeId, year],
  )
}

export async function insertLeaveRequest(
  q: Q,
  input: {
    tenantId: string
    employeeId: string
    leaveTypeId: string
    startDate: string
    endDate: string
    daysRequested: number
    reason?: string
  },
): Promise<LeaveRequest> {
  const id = newId()
  await q.exec(
    `INSERT INTO leave_requests
       (id, tenant_id, employee_id, leave_type_id, start_date, end_date, days_requested, status, reason, submitted_via)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, 'web')`,
    [id, input.tenantId, input.employeeId, input.leaveTypeId, input.startDate, input.endDate, input.daysRequested, input.reason ?? null],
  )
  const created = await getLeaveRequest(q, id)
  if (!created) throw new Error('INSERT_LEAVE_REQUEST_FAILED')
  return created
}

export function getLeaveRequest(q: Q, id: string): Promise<LeaveRequest | null> {
  return q.query<LeaveRequestRow>(`SELECT ${REQUEST_COLS} FROM leave_requests lr WHERE lr.id = $1`, [id]).then((r) => (r.rows[0] ? mapRequest(r.rows[0]) : null))
}

export async function listLeaveRequests(
  q: Q,
  filter: { status?: string; employeeId?: string },
  page: number,
  pageSize: number,
): Promise<{ data: LeaveRequest[]; total: number }> {
  const conds: string[] = []
  const params: unknown[] = []
  if (filter.employeeId) {
    params.push(filter.employeeId)
    conds.push(`lr.employee_id = $${params.length}`)
  }
  if (filter.status) {
    params.push(filter.status)
    conds.push(`lr.status = $${params.length}`)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  const totalRes = await q.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM leave_requests lr ${where}`,
    params,
  )
  const total = totalRes.rows[0]?.total ?? 0

  const offset = (page - 1) * pageSize
  const dataRes = await q.query<LeaveRequestRow>(
    `SELECT ${REQUEST_COLS} FROM leave_requests lr ${where}
     ORDER BY lr.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  )
  return { data: dataRes.rows.map(mapRequest), total }
}

export async function decideLeaveRequest(
  q: Q,
  id: string,
  input: { decision: 'approved' | 'rejected'; decisionNote?: string; approverEmployeeId: string },
): Promise<LeaveRequest | null> {
  await q.exec(
    `UPDATE leave_requests
     SET status = $1, decision_note = $2, approver_employee_id = $3, decided_at = now(), updated_at = now()
     WHERE id = $4 AND status = 'pending'`,
    [input.decision, input.decisionNote ?? null, input.approverEmployeeId, id],
  )
  return getLeaveRequest(q, id)
}