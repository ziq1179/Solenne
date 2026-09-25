import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { audit } from '../../lib/audit.js'
import { PERMISSIONS } from '../permissions.js'
import * as repo from './payroll.repo.js'
import { SyntheticTaxEngine } from './tax-engine.js'

const createRunSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().max(3).optional(),
  notes: z.string().max(500).optional(),
  correctionOf: z.string().uuid().nullable().optional(),
})

const taxEngine = new SyntheticTaxEngine()

export function registerPayrollRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  // ── GET /payroll/runs ──────────────────────────────────────────────────────
  fastify.get(
    '/payroll/runs',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PAYROLL_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const status = qs.status
      const page = Number(qs.page) || 1
      const pageSize = Number(qs.pageSize) || 25
      return db.tenant(req.ctx.tenantId, (q) => repo.listPayrollRuns(q, { status, page, pageSize }))
    },
  )

  // ── POST /payroll/runs ─────────────────────────────────────────────────────
  fastify.post(
    '/payroll/runs',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PAYROLL_WRITE)] },
    async (req) => {
      const parsed = createRunSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const run = await repo.createPayrollRun(q, {
          ...parsed.data,
          createdBy: req.ctx.userId,
        })
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'payroll.run.created',
          entityType: 'payroll_run',
          entityId: run.id,
          after: run,
        })
        return run
      })
    },
  )

  // ── POST /payroll/runs/:id/calculate ───────────────────────────────────────
  fastify.post(
    '/payroll/runs/:id/calculate',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PAYROLL_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const run = await repo.getPayrollRun(q, id)
        if (!run) throw httpError.notFound('Payroll run not found')
        if (run.status !== 'draft') throw httpError.badRequest('Only draft runs can be calculated')

        const compensations = await repo.listCurrentCompensation(q)
        if (compensations.length === 0) throw httpError.badRequest('No compensation records found for active employees')

        let totalGross = 0
        let totalNet = 0
        let totalDeductions = 0

        for (const comp of compensations) {
          // Calculate base pay for the period
          const basePay = calculatePeriodPay(comp.baseSalaryAmount, comp.payFrequency, run.periodStart, run.periodEnd)

          // Apply tax engine
          const taxResult = taxEngine.calculate({
            tenantCountry: 'US',
            employeeCountry: 'US',
            grossPay: basePay,
            payFrequency: comp.payFrequency as 'monthly' | 'biweekly' | 'weekly',
            taxYear: new Date(run.periodStart).getFullYear(),
          })

          const netPay = basePay - taxResult.totalDeductions

          await repo.createPayslip(q, {
            payrollRunId: run.id,
            employeeId: comp.employeeId,
            compensationRecordId: comp.id,
            basePay,
            grossPay: basePay,
            deductions: taxResult.deductions,
            totalDeductions: taxResult.totalDeductions,
            netPay,
            currency: run.currency,
            taxCompliant: taxResult.compliant,
          })

          totalGross += basePay
          totalNet += netPay
          totalDeductions += taxResult.totalDeductions
        }

        await repo.updatePayrollRunTotals(q, run.id, {
          totalGross,
          totalNet,
          totalDeductions,
          employeeCount: compensations.length,
        })
        await repo.updatePayrollRunStatus(q, run.id, 'calculated')

        const updated = await repo.getPayrollRun(q, run.id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'payroll.run.calculated',
          entityType: 'payroll_run',
          entityId: run.id,
          before: { status: 'draft' },
          after: updated,
        })
        return updated
      })
    },
  )

  // ── POST /payroll/runs/:id/approve ─────────────────────────────────────────
  fastify.post(
    '/payroll/runs/:id/approve',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PAYROLL_APPROVE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const run = await repo.getPayrollRun(q, id)
        if (!run) throw httpError.notFound('Payroll run not found')
        if (run.status !== 'calculated') throw httpError.badRequest('Only calculated runs can be approved')

        await repo.updatePayrollRunStatus(q, run.id, 'approved', { approvedBy: req.ctx.userId })
        const updated = await repo.getPayrollRun(q, run.id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'payroll.run.approved',
          entityType: 'payroll_run',
          entityId: run.id,
          before: { status: 'calculated' },
          after: { status: 'approved', approvedBy: req.ctx.userId },
        })
        return updated
      })
    },
  )

  // ── POST /payroll/runs/:id/pay ─────────────────────────────────────────────
  fastify.post(
    '/payroll/runs/:id/pay',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PAYROLL_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const run = await repo.getPayrollRun(q, id)
        if (!run) throw httpError.notFound('Payroll run not found')
        if (run.status !== 'approved') throw httpError.badRequest('Only approved runs can be marked as paid')

        await repo.updatePayrollRunStatus(q, run.id, 'paid', { paidAt: true })
        const updated = await repo.getPayrollRun(q, run.id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'payroll.run.paid',
          entityType: 'payroll_run',
          entityId: run.id,
          before: { status: 'approved' },
          after: { status: 'paid' },
        })
        return updated
      })
    },
  )

  // ── GET /payroll/runs/:id/payslips ─────────────────────────────────────────
  fastify.get(
    '/payroll/runs/:id/payslips',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PAYROLL_READ)] },
    async (req) => {
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const run = await repo.getPayrollRun(q, id)
        if (!run) throw httpError.notFound('Payroll run not found')
        // Manager-scoped: only direct reports' payslips
        if (req.ctx.roles.includes('manager') && !req.ctx.roles.includes('admin') && !req.ctx.roles.includes('hr_manager')) {
          if (!req.ctx.employeeId) throw httpError.forbidden('No employee record linked to this account')
          return repo.listPayslipsByRunForManager(q, id, req.ctx.employeeId)
        }
        return repo.listPayslipsByRun(q, id)
      })
    },
  )

  // ── GET /payroll/payslips/:id ──────────────────────────────────────────────
  fastify.get(
    '/payroll/payslips/:id',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PAYROLL_READ)] },
    async (req) => {
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        // Manager-scoped: single payslip only if employee reports to this manager
        if (req.ctx.roles.includes('manager') && !req.ctx.roles.includes('admin') && !req.ctx.roles.includes('hr_manager')) {
          if (!req.ctx.employeeId) throw httpError.forbidden('No employee record linked to this account')
          const payslip = await repo.getPayslipForManager(q, id, req.ctx.employeeId)
          if (!payslip) throw httpError.notFound('Payslip not found')
          return payslip
        }
        const payslip = await repo.getPayslip(q, id)
        if (!payslip) throw httpError.notFound('Payslip not found')
        return payslip
      })
    },
  )

  // ── GET /payroll/my-payslips ───────────────────────────────────────────────
  fastify.get(
    '/payroll/my-payslips',
    { preHandler: [authenticate] },
    async (req) => {
      const employeeId = req.ctx.employeeId
      if (!employeeId) throw httpError.forbidden('No employee record linked to this account')
      return db.tenant(req.ctx.tenantId, (q) => repo.listPayslipsByEmployee(q, employeeId))
    },
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Calculate pay for a period based on annual salary and pay frequency. */
function calculatePeriodPay(
  annualSalary: number,
  payFrequency: string,
  periodStart: string,
  periodEnd: string,
): number {
  const start = new Date(periodStart)
  const end = new Date(periodEnd)
  const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
  const yearDays = 365

  switch (payFrequency) {
    case 'monthly':
      return round((annualSalary / 12) * (days / 30))
    case 'biweekly':
      return round((annualSalary / 26) * (days / 14))
    case 'weekly':
      return round((annualSalary / 52) * (days / 7))
    default:
      return round(annualSalary / 12)
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
