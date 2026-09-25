/**
 * Payroll repository. Query helpers for payroll_runs and payslips.
 * All queries run within tenant-scoped transactions.
 */

import type { Q } from '../../db/index.js'
import { newId } from '../../db/index.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PayrollRun {
  id: string
  tenantId: string
  periodStart: string
  periodEnd: string
  status: string
  totalGross: number | null
  totalNet: number | null
  totalDeductions: number | null
  employeeCount: number | null
  currency: string
  notes: string | null
  correctionOf: string | null
  approvedBy: string | null
  approvedAt: string | null
  paidAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface Payslip {
  id: string
  tenantId: string
  payrollRunId: string
  employeeId: string
  compensationRecordId: string
  basePay: number
  overtimePay: number
  bonus: number
  otherEarnings: number
  grossPay: number
  deductions: unknown
  totalDeductions: number
  netPay: number
  currency: string
  taxCompliant: boolean
  createdAt: string
}

export interface CompensationRecord {
  id: string
  employeeId: string
  effectiveDate: string
  baseSalaryAmount: number
  currency: string
  payFrequency: string
}

// ─── Payroll Runs ────────────────────────────────────────────────────────────

export async function listPayrollRuns(
  q: Q,
  opts: { status?: string; page?: number; pageSize?: number } = {},
): Promise<{ data: PayrollRun[]; total: number }> {
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
    q.query<PayrollRun>(
      `SELECT ${RUN_COLS} FROM payroll_runs ${where} ORDER BY period_start DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    q.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM payroll_runs ${where}`,
      params.slice(0, -2),
    ),
  ])

  return { data: dataRes.rows, total: countRes.rows[0]?.count ?? 0 }
}

export async function getPayrollRun(q: Q, id: string): Promise<PayrollRun | null> {
  const res = await q.query<PayrollRun>(`SELECT ${RUN_COLS} FROM payroll_runs WHERE id = $1`, [id])
  return res.rows[0] ?? null
}

export async function createPayrollRun(
  q: Q,
  opts: {
    periodStart: string
    periodEnd: string
    currency?: string
    notes?: string
    correctionOf?: string | null
    createdBy: string
  },
): Promise<PayrollRun> {
  const id = newId()
  await q.exec(
    `INSERT INTO payroll_runs (id, tenant_id, period_start, period_end, currency, notes, correction_of, created_by)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4, $5, $6, $7)`,
    [id, opts.periodStart, opts.periodEnd, opts.currency ?? 'USD', opts.notes ?? null, opts.correctionOf ?? null, opts.createdBy],
  )
  const run = await getPayrollRun(q, id)
  return run!
}

export async function updatePayrollRunStatus(
  q: Q,
  id: string,
  status: string,
  extra?: { approvedBy?: string; paidAt?: boolean },
): Promise<void> {
  const sets = ['status = $2', 'updated_at = now()']
  const params: unknown[] = [id, status]
  if (extra?.approvedBy) {
    params.push(extra.approvedBy)
    sets.push(`approved_by = $${params.length}`, `approved_at = now()`)
  }
  if (extra?.paidAt) {
    sets.push(`paid_at = now()`)
  }
  await q.exec(`UPDATE payroll_runs SET ${sets.join(', ')} WHERE id = $1`, params)
}

export async function updatePayrollRunTotals(
  q: Q,
  id: string,
  totals: { totalGross: number; totalNet: number; totalDeductions: number; employeeCount: number },
): Promise<void> {
  await q.exec(
    `UPDATE payroll_runs
     SET total_gross = $2, total_net = $3, total_deductions = $4, employee_count = $5, updated_at = now()
     WHERE id = $1`,
    [id, totals.totalGross, totals.totalNet, totals.totalDeductions, totals.employeeCount],
  )
}

// ─── Column Aliases ──────────────────────────────────────────────────────────
// Postgres returns snake_case; these aliases map to the camelCase interfaces.

const PAYSLIP_COLS = `p.id, p.tenant_id AS "tenantId", p.payroll_run_id AS "payrollRunId",
  p.employee_id AS "employeeId", p.compensation_record_id AS "compensationRecordId",
  p.base_pay AS "basePay", p.overtime_pay AS "overtimePay", p.bonus, p.other_earnings AS "otherEarnings",
  p.gross_pay AS "grossPay", p.deductions, p.total_deductions AS "totalDeductions",
  p.net_pay AS "netPay", p.currency, p.tax_compliant AS "taxCompliant", p.created_at AS "createdAt"`

const RUN_COLS = `id, tenant_id AS "tenantId", period_start AS "periodStart", period_end AS "periodEnd",
  status, total_gross AS "totalGross", total_net AS "totalNet", total_deductions AS "totalDeductions",
  employee_count AS "employeeCount", currency, notes, correction_of AS "correctionOf",
  approved_by AS "approvedBy", approved_at AS "approvedAt", paid_at AS "paidAt",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`

// ─── Payslips ────────────────────────────────────────────────────────────────

export async function listPayslipsByRun(q: Q, payrollRunId: string): Promise<Payslip[]> {
  const res = await q.query<Payslip>(
    `SELECT ${PAYSLIP_COLS} FROM payslips p WHERE p.payroll_run_id = $1 ORDER BY p.employee_id`,
    [payrollRunId],
  )
  return res.rows
}

/** Manager-scoped: only payslips for employees whose manager_employee_id matches. */
export async function listPayslipsByRunForManager(q: Q, payrollRunId: string, managerEmployeeId: string): Promise<Payslip[]> {
  const res = await q.query<Payslip>(
    `SELECT ${PAYSLIP_COLS} FROM payslips p
     JOIN employees e ON e.id = p.employee_id
     WHERE p.payroll_run_id = $1 AND e.manager_employee_id = $2
     ORDER BY p.employee_id`,
    [payrollRunId, managerEmployeeId],
  )
  return res.rows
}

export async function getPayslip(q: Q, id: string): Promise<Payslip | null> {
  const res = await q.query<Payslip>(`SELECT ${PAYSLIP_COLS} FROM payslips p WHERE p.id = $1`, [id])
  return res.rows[0] ?? null
}

/** Manager-scoped: single payslip only if employee reports to this manager. */
export async function getPayslipForManager(q: Q, id: string, managerEmployeeId: string): Promise<Payslip | null> {
  const res = await q.query<Payslip>(
    `SELECT ${PAYSLIP_COLS} FROM payslips p
     JOIN employees e ON e.id = p.employee_id
     WHERE p.id = $1 AND e.manager_employee_id = $2`,
    [id, managerEmployeeId],
  )
  return res.rows[0] ?? null
}

export async function listPayslipsByEmployee(q: Q, employeeId: string): Promise<Payslip[]> {
  const res = await q.query<Payslip>(
    `SELECT ${PAYSLIP_COLS} FROM payslips p
     JOIN payroll_runs pr ON pr.id = p.payroll_run_id
     WHERE p.employee_id = $1
     ORDER BY pr.period_start DESC`,
    [employeeId],
  )
  return res.rows
}

export async function createPayslip(
  q: Q,
  opts: {
    payrollRunId: string
    employeeId: string
    compensationRecordId: string
    basePay: number
    overtimePay?: number
    bonus?: number
    otherEarnings?: number
    grossPay: number
    deductions: unknown
    totalDeductions: number
    netPay: number
    currency?: string
    taxCompliant?: boolean
  },
): Promise<Payslip> {
  const id = newId()
  await q.exec(
    `INSERT INTO payslips
       (id, tenant_id, payroll_run_id, employee_id, compensation_record_id,
        base_pay, overtime_pay, bonus, other_earnings, gross_pay,
        deductions, total_deductions, net_pay, currency, tax_compliant)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4,
             $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)`,
    [
      id,
      opts.payrollRunId,
      opts.employeeId,
      opts.compensationRecordId,
      opts.basePay,
      opts.overtimePay ?? 0,
      opts.bonus ?? 0,
      opts.otherEarnings ?? 0,
      opts.grossPay,
      JSON.stringify(opts.deductions),
      opts.totalDeductions,
      opts.netPay,
      opts.currency ?? 'USD',
      opts.taxCompliant ?? false,
    ],
  )
  return (await getPayslip(q, id))!
}

// ─── Compensation Records ────────────────────────────────────────────────────

export async function listCurrentCompensation(q: Q): Promise<CompensationRecord[]> {
  const res = await q.query<CompensationRecord>(
    `SELECT DISTINCT ON (employee_id)
       id, employee_id AS "employeeId", effective_date AS "effectiveDate",
       base_salary_amount AS "baseSalaryAmount", currency, pay_frequency AS "payFrequency"
     FROM compensation_records
     WHERE tenant_id = current_setting('app.current_tenant', true)::uuid
     ORDER BY employee_id, effective_date DESC`,
  )
  return res.rows
}
