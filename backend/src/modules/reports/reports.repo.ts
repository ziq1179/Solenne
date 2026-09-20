import type { Q } from '../../db/index.js'

export interface CountByName {
  id: string | null
  name: string | null
  count: number
}

export interface HeadcountReport {
  total: number
  byDepartment: CountByName[]
  byLocation: (CountByName & { country: string | null })[]
  byEmploymentType: { employmentType: string; count: number }[]
}

export async function headcount(q: Q, status: string): Promise<HeadcountReport> {
  const totalRes = await q.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM employees e
     WHERE e.deleted_at IS NULL AND e.employment_status = $1`,
    [status],
  )
  const total = totalRes.rows[0]?.total ?? 0

  const byDepartmentRes = await q.query<CountByName>(
    `SELECT d.id AS "id", d.name AS "name", count(*)::int AS "count"
     FROM employees e LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.deleted_at IS NULL AND e.employment_status = $1
     GROUP BY d.id, d.name
     ORDER BY "count" DESC, d.name`,
    [status],
  )

  const byLocationRes = await q.query<CountByName & { country: string | null }>(
    `SELECT l.id AS "id", l.name AS "name", l.country AS "country", count(*)::int AS "count"
     FROM employees e LEFT JOIN locations l ON l.id = e.location_id
     WHERE e.deleted_at IS NULL AND e.employment_status = $1
     GROUP BY l.id, l.name, l.country
     ORDER BY "count" DESC, l.name`,
    [status],
  )

  const byEmploymentTypeRes = await q.query<{ employmentType: string; count: number }>(
    `SELECT e.employment_type AS "employmentType", count(*)::int AS "count"
     FROM employees e
     WHERE e.deleted_at IS NULL AND e.employment_status = $1
     GROUP BY e.employment_type
     ORDER BY "count" DESC, e.employment_type`,
    [status],
  )

  return {
    total,
    byDepartment: byDepartmentRes.rows,
    byLocation: byLocationRes.rows,
    byEmploymentType: byEmploymentTypeRes.rows,
  }
}

export interface AttendanceSummaryRow {
  employeeId: string
  employeeNumber: string
  firstName: string
  lastName: string
  departmentName: string | null
  clockIns: number
  totalMinutes: number
}

export interface AttendanceSummary {
  totalEmployees: number
  totalClockIns: number
  totalMinutes: number
  rows: AttendanceSummaryRow[]
}

export async function attendanceSummary(q: Q, from: string, to: string): Promise<AttendanceSummary> {
  const res = await q.query<AttendanceSummaryRow>(
    `SELECT e.id AS "employeeId", e.employee_number AS "employeeNumber",
            e.first_name AS "firstName", e.last_name AS "lastName",
            d.name AS "departmentName",
            count(ar.id)::int AS "clockIns",
            coalesce(sum(ar.total_minutes), 0)::int AS "totalMinutes"
     FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ar.clock_in_at >= $1::date AND ar.clock_in_at < ($2::date + interval '1 day')
     GROUP BY e.id, e.employee_number, e.first_name, e.last_name, d.name
     ORDER BY "totalMinutes" DESC, e.first_name, e.last_name`,
    [from, to],
  )
  const totalMinutes = res.rows.reduce((sum, r) => sum + (r.totalMinutes ?? 0), 0)
  const totalClockIns = res.rows.reduce((sum, r) => sum + r.clockIns, 0)
  return { totalEmployees: res.rows.length, totalClockIns, totalMinutes, rows: res.rows }
}

export interface LeaveTypeBalance {
  leaveTypeId: string
  leaveTypeName: string
  accruedDays: number
  usedDays: number
  carriedOverDays: number
  remainingDays: number
}

export interface LeaveSummaryRow {
  employeeId: string
  employeeNumber: string
  firstName: string
  lastName: string
  balances: LeaveTypeBalance[]
}

export async function leaveSummary(q: Q, year: number): Promise<LeaveSummaryRow[]> {
  const res = await q.query<{
    employeeId: string
    employeeNumber: string
    firstName: string
    lastName: string
    leaveTypeId: string
    leaveTypeName: string
    accruedDays: number
    usedDays: number
    carriedOverDays: number
    remainingDays: number
  }>(
    `SELECT e.id AS "employeeId", e.employee_number AS "employeeNumber",
            e.first_name AS "firstName", e.last_name AS "lastName",
            lt.id AS "leaveTypeId", lt.name AS "leaveTypeName",
            lb.accrued_days::float8 AS "accruedDays",
            lb.used_days::float8 AS "usedDays",
            lb.carried_over_days::float8 AS "carriedOverDays",
            (lb.accrued_days + lb.carried_over_days - lb.used_days)::float8 AS "remainingDays"
     FROM leave_balances lb
     JOIN employees e ON e.id = lb.employee_id
     JOIN leave_types lt ON lt.id = lb.leave_type_id
     WHERE lb.year = $1 AND e.deleted_at IS NULL
     ORDER BY e.first_name, e.last_name, lt.name`,
    [year],
  )

  const rows: LeaveSummaryRow[] = []
  const index = new Map<string, LeaveSummaryRow>()
  for (const r of res.rows) {
    let row = index.get(r.employeeId)
    if (!row) {
      row = {
        employeeId: r.employeeId,
        employeeNumber: r.employeeNumber,
        firstName: r.firstName,
        lastName: r.lastName,
        balances: [],
      }
      index.set(r.employeeId, row)
      rows.push(row)
    }
    row.balances.push({
      leaveTypeId: r.leaveTypeId,
      leaveTypeName: r.leaveTypeName,
      accruedDays: r.accruedDays,
      usedDays: r.usedDays,
      carriedOverDays: r.carriedOverDays,
      remainingDays: r.remainingDays,
    })
  }
  return rows
}