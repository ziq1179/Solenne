import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { audit } from '../../lib/audit.js'
import { PERMISSIONS } from '../permissions.js'
import * as repo from './benefits.repo.js'
import { StubCarrierEngine } from './carrier-engine.js'

const carrierEngine = new StubCarrierEngine()

const createPlanSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  planType: z.enum(['medical', 'dental', 'vision', 'life_insurance', 'retirement', 'hsa', 'fsa', 'other']),
  carrierName: z.string().max(200).optional(),
  coverageTiers: z.array(z.enum(['employee_only', 'employee_spouse', 'employee_child', 'family'])).min(1),
  employerContributionPct: z.number().min(0).max(100).optional(),
  employeeCost: z.record(z.number().min(0)),
})

const updatePlanSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  planType: z.enum(['medical', 'dental', 'vision', 'life_insurance', 'retirement', 'hsa', 'fsa', 'other']).optional(),
  carrierName: z.string().max(200).optional(),
  coverageTiers: z.array(z.enum(['employee_only', 'employee_spouse', 'employee_child', 'family'])).optional(),
  employerContributionPct: z.number().min(0).max(100).optional(),
  employeeCost: z.record(z.number().min(0)).optional(),
  isActive: z.boolean().optional(),
})

const createPeriodSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  periodType: z.enum(['open_enrollment', 'life_event']).optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  coverageStarts: z.string().optional(),
})

const periodStatusSchema = z.object({
  status: z.enum(['active', 'closed', 'finalized']),
})

const createEnrollmentSchema = z.object({
  employeeId: z.string().uuid().optional(),
  enrollmentPeriodId: z.string().uuid(),
  benefitPlanId: z.string().uuid(),
  coverageTier: z.enum(['employee_only', 'employee_spouse', 'employee_child', 'family']),
  employeePremium: z.number().min(0),
  employerPremium: z.number().min(0),
  notes: z.string().max(500).optional(),
  dependentIds: z.array(z.string().uuid()).optional(),
})

const createDependentSchema = z.object({
  employeeId: z.string().uuid().optional(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  relationship: z.enum(['spouse', 'child', 'domestic_partner']),
  dateOfBirth: z.string().optional(),
  ssnEnc: z.string().optional(),
})

const updateDependentSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  relationship: z.enum(['spouse', 'child', 'domestic_partner']).optional(),
  dateOfBirth: z.string().optional(),
  ssnEnc: z.string().optional(),
})

const createLifeEventSchema = z.object({
  employeeId: z.string().uuid().optional(),
  eventType: z.enum(['marriage', 'birth', 'divorce', 'death', 'adoption', 'loss_of_other_coverage', 'gain_of_other_coverage']),
  eventDate: z.string(),
  description: z.string().max(2000).optional(),
})

const VALID_PERIOD_TRANSITIONS: Record<string, string[]> = {
  draft: ['active'],
  active: ['closed'],
  closed: ['finalized'],
}

function isManagerScoped(roles: string[]): boolean {
  return roles.includes('manager') && !roles.includes('admin') && !roles.includes('hr_manager')
}

function isAdminOrHr(roles: string[]): boolean {
  return roles.includes('admin') || roles.includes('hr_manager')
}

export function registerBenefitsRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  // ── GET /benefits/plans ───────────────────────────────────────────────────
  fastify.get(
    '/benefits/plans',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_READ)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const qs = req.query as Record<string, string | undefined>
      const activeOnly = qs.activeOnly === 'true'
      return db.tenant(req.ctx.tenantId, (q) => repo.listBenefitPlans(q, { activeOnly }))
    },
  )

  // ── POST /benefits/plans ──────────────────────────────────────────────────
  fastify.post(
    '/benefits/plans',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const parsed = createPlanSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const plan = await repo.createBenefitPlan(q, { ...parsed.data, createdBy: req.ctx.userId })
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.plan.created',
          entityType: 'benefit_plan',
          entityId: plan.id,
          after: plan,
        })
        return plan
      })
    },
  )

  // ── PATCH /benefits/plans/:id ─────────────────────────────────────────────
  fastify.patch(
    '/benefits/plans/:id',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const { id } = req.params as { id: string }
      const parsed = updatePlanSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const existing = await repo.getBenefitPlan(q, id)
        if (!existing) throw httpError.notFound('Benefit plan not found')
        const before = { ...existing }
        await repo.updateBenefitPlan(q, id, parsed.data)
        const after = await repo.getBenefitPlan(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.plan.updated',
          entityType: 'benefit_plan',
          entityId: id,
          before,
          after,
        })
        return after
      })
    },
  )

  // ── GET /benefits/periods ─────────────────────────────────────────────────
  fastify.get(
    '/benefits/periods',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_READ)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const qs = req.query as Record<string, string | undefined>
      return db.tenant(req.ctx.tenantId, (q) => repo.listEnrollmentPeriods(q, { status: qs.status }))
    },
  )

  // ── POST /benefits/periods ────────────────────────────────────────────────
  fastify.post(
    '/benefits/periods',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const parsed = createPeriodSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const period = await repo.createEnrollmentPeriod(q, { ...parsed.data, createdBy: req.ctx.userId })
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.period.created',
          entityType: 'enrollment_period',
          entityId: period.id,
          after: period,
        })
        return period
      })
    },
  )

  // ── POST /benefits/periods/:id/status ─────────────────────────────────────
  fastify.post(
    '/benefits/periods/:id/status',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const { id } = req.params as { id: string }
      const parsed = periodStatusSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const period = await repo.getEnrollmentPeriod(q, id)
        if (!period) throw httpError.notFound('Enrollment period not found')

        const allowed = VALID_PERIOD_TRANSITIONS[period.status]
        if (!allowed || !allowed.includes(parsed.data.status)) {
          throw httpError.badRequest(`Cannot transition from '${period.status}' to '${parsed.data.status}'`)
        }

        await repo.updateEnrollmentPeriodStatus(q, id, parsed.data.status)
        const updated = await repo.getEnrollmentPeriod(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.period.status',
          entityType: 'enrollment_period',
          entityId: id,
          before: { status: period.status },
          after: { status: parsed.data.status },
        })
        return updated
      })
    },
  )

  // ── GET /benefits/enrollments ─────────────────────────────────────────────
  fastify.get(
    '/benefits/enrollments',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_READ)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const qs = req.query as Record<string, string | undefined>
      const page = Number(qs.page) || 1
      const pageSize = Number(qs.pageSize) || 25
      return db.tenant(req.ctx.tenantId, (q) =>
        repo.listBenefitEnrollments(q, { periodId: qs.periodId, page, pageSize }),
      )
    },
  )

  // ── POST /benefits/enrollments ────────────────────────────────────────────
  fastify.post(
    '/benefits/enrollments',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const parsed = createEnrollmentSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        // Resolve employee: employee can only create for self
        let employeeId = parsed.data.employeeId
        if (!employeeId) {
          employeeId = req.ctx.employeeId ?? undefined
        }
        if (!employeeId) throw httpError.forbidden('No employee record linked to this account')

        // Employees can only create for themselves
        if (!isAdminOrHr(req.ctx.roles) && employeeId !== req.ctx.employeeId) {
          throw httpError.forbidden('You can only create enrollments for yourself')
        }

        // Verify enrollment period is active
        const period = await repo.getEnrollmentPeriod(q, parsed.data.enrollmentPeriodId)
        if (!period) throw httpError.notFound('Enrollment period not found')
        if (period.status !== 'active') throw httpError.badRequest('Enrollment period is not active')

        let enrollment
        try {
          enrollment = await repo.createBenefitEnrollment(q, {
            ...parsed.data,
            employeeId,
            createdBy: req.ctx.userId,
          })
        } catch (err: any) {
          if (err.code === '23505') throw httpError.conflict('You already have an enrollment for this plan in this period')
          throw err
        }

        // Link dependents if provided
        if (parsed.data.dependentIds?.length) {
          for (const depId of parsed.data.dependentIds) {
            const dep = await repo.getBenefitDependent(q, depId)
            if (!dep || dep.employeeId !== employeeId) {
              throw httpError.badRequest(`Dependent ${depId} not found or does not belong to this employee`)
            }
            await repo.linkEnrollmentDependent(q, enrollment.id, depId)
          }
        }

        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.enrollment.created',
          entityType: 'benefit_enrollment',
          entityId: enrollment.id,
          after: enrollment,
        })
        return enrollment
      })
    },
  )

  // ── POST /benefits/enrollments/:id/submit ─────────────────────────────────
  fastify.post(
    '/benefits/enrollments/:id/submit',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const enrollment = await repo.getBenefitEnrollment(q, id)
        if (!enrollment) throw httpError.notFound('Enrollment not found')

        // Ownership check
        if (!isAdminOrHr(req.ctx.roles) && enrollment.employeeId !== req.ctx.employeeId) {
          throw httpError.forbidden('Access denied')
        }
        if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')

        if (enrollment.status !== 'draft') throw httpError.badRequest('Only draft enrollments can be submitted')

        // Verify period is still active
        const period = await repo.getEnrollmentPeriod(q, enrollment.enrollmentPeriodId)
        if (!period || period.status !== 'active') throw httpError.badRequest('Enrollment period is not active')

        await repo.updateBenefitEnrollmentStatus(q, id, 'submitted', { submittedAt: true })
        const updated = await repo.getBenefitEnrollment(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.enrollment.submitted',
          entityType: 'benefit_enrollment',
          entityId: id,
          before: { status: enrollment.status },
          after: { status: 'submitted' },
        })
        return updated
      })
    },
  )

  // ── POST /benefits/enrollments/:id/confirm ────────────────────────────────
  fastify.post(
    '/benefits/enrollments/:id/confirm',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const enrollment = await repo.getBenefitEnrollment(q, id)
        if (!enrollment) throw httpError.notFound('Enrollment not found')
        if (enrollment.status !== 'submitted') throw httpError.badRequest('Only submitted enrollments can be confirmed')

        const plan = await repo.getBenefitPlan(q, enrollment.benefitPlanId)
        const dependents = await repo.listEnrollmentDependents(q, id)
        carrierEngine.transmitEnrollment({
          tenantId: req.ctx.tenantId,
          employeeId: enrollment.employeeId,
          planName: plan?.name ?? 'Unknown',
          planType: plan?.planType ?? 'other',
          coverageTier: enrollment.coverageTier,
          employeePremium: Number(enrollment.employeePremium),
          employerPremium: Number(enrollment.employerPremium),
          dependents: dependents.map((d) => ({
            firstName: d.firstName,
            lastName: d.lastName,
            relationship: d.relationship,
            dateOfBirth: d.dateOfBirth ?? '',
          })),
        })

        await repo.updateBenefitEnrollmentStatus(q, id, 'confirmed', { confirmedAt: true })
        const updated = await repo.getBenefitEnrollment(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.enrollment.confirmed',
          entityType: 'benefit_enrollment',
          entityId: id,
          before: { status: enrollment.status },
          after: { status: 'confirmed' },
        })
        return updated
      })
    },
  )

  // ── POST /benefits/enrollments/:id/withdraw ───────────────────────────────
  fastify.post(
    '/benefits/enrollments/:id/withdraw',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const enrollment = await repo.getBenefitEnrollment(q, id)
        if (!enrollment) throw httpError.notFound('Enrollment not found')

        if (!isAdminOrHr(req.ctx.roles) && enrollment.employeeId !== req.ctx.employeeId) {
          throw httpError.forbidden('Access denied')
        }
        if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')

        if (enrollment.status !== 'submitted') throw httpError.badRequest('Only submitted enrollments can be withdrawn')

        // Verify period is still active
        const period = await repo.getEnrollmentPeriod(q, enrollment.enrollmentPeriodId)
        if (!period || period.status !== 'active') throw httpError.badRequest('Enrollment period is not active')

        await repo.updateBenefitEnrollmentStatus(q, id, 'withdrawn', { withdrawnAt: true })
        const updated = await repo.getBenefitEnrollment(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.enrollment.withdrawn',
          entityType: 'benefit_enrollment',
          entityId: id,
          before: { status: enrollment.status },
          after: { status: 'withdrawn' },
        })
        return updated
      })
    },
  )

  // ── GET /benefits/dependents ──────────────────────────────────────────────
  fastify.get(
    '/benefits/dependents',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_READ)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      return db.tenant(req.ctx.tenantId, (q) => repo.listBenefitDependents(q))
    },
  )

  // ── POST /benefits/dependents ─────────────────────────────────────────────
  fastify.post(
    '/benefits/dependents',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const parsed = createDependentSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        let employeeId = parsed.data.employeeId
        if (!employeeId) {
          employeeId = req.ctx.employeeId ?? undefined
        }
        if (!employeeId) throw httpError.forbidden('No employee record linked to this account')

        if (!isAdminOrHr(req.ctx.roles) && employeeId !== req.ctx.employeeId) {
          throw httpError.forbidden('You can only add dependents for yourself')
        }

        const dependent = await repo.createBenefitDependent(q, { ...parsed.data, employeeId })
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.dependent.created',
          entityType: 'benefit_dependent',
          entityId: dependent.id,
          after: dependent,
        })
        return dependent
      })
    },
  )

  // ── PATCH /benefits/dependents/:id ────────────────────────────────────────
  fastify.patch(
    '/benefits/dependents/:id',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      const parsed = updateDependentSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const existing = await repo.getBenefitDependent(q, id)
        if (!existing) throw httpError.notFound('Dependent not found')

        if (!isAdminOrHr(req.ctx.roles) && existing.employeeId !== req.ctx.employeeId) {
          throw httpError.forbidden('Access denied')
        }
        if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')

        const before = { ...existing }
        await repo.updateBenefitDependent(q, id, parsed.data)
        const after = await repo.getBenefitDependent(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.dependent.updated',
          entityType: 'benefit_dependent',
          entityId: id,
          before,
          after,
        })
        return after
      })
    },
  )

  // ── POST /benefits/dependents/:id/deactivate ──────────────────────────────
  fastify.post(
    '/benefits/dependents/:id/deactivate',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const existing = await repo.getBenefitDependent(q, id)
        if (!existing) throw httpError.notFound('Dependent not found')

        if (!isAdminOrHr(req.ctx.roles) && existing.employeeId !== req.ctx.employeeId) {
          throw httpError.forbidden('Access denied')
        }
        if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')

        const before = { ...existing }
        await repo.deactivateBenefitDependent(q, id)
        const after = await repo.getBenefitDependent(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.dependent.deactivated',
          entityType: 'benefit_dependent',
          entityId: id,
          before,
          after,
        })
        return after
      })
    },
  )

  // ── GET /benefits/life-events ─────────────────────────────────────────────
  fastify.get(
    '/benefits/life-events',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_READ)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      return db.tenant(req.ctx.tenantId, (q) => repo.listLifeEvents(q))
    },
  )

  // ── POST /benefits/life-events ────────────────────────────────────────────
  fastify.post(
    '/benefits/life-events',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const parsed = createLifeEventSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        let employeeId = parsed.data.employeeId
        if (!employeeId) {
          employeeId = req.ctx.employeeId ?? undefined
        }
        if (!employeeId) throw httpError.forbidden('No employee record linked to this account')

        if (!isAdminOrHr(req.ctx.roles) && employeeId !== req.ctx.employeeId) {
          throw httpError.forbidden('You can only report life events for yourself')
        }

        const event = await repo.createLifeEvent(q, { ...parsed.data, employeeId })
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.life_event.reported',
          entityType: 'life_event',
          entityId: event.id,
          after: event,
        })
        return event
      })
    },
  )

  // ── POST /benefits/life-events/:id/acknowledge ────────────────────────────
  fastify.post(
    '/benefits/life-events/:id/acknowledge',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BENEFITS_WRITE)] },
    async (req) => {
      if (isManagerScoped(req.ctx.roles)) throw httpError.forbidden('Managers do not have access to benefits data')
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const event = await repo.getLifeEvent(q, id)
        if (!event) throw httpError.notFound('Life event not found')
        if (event.status !== 'reported') throw httpError.badRequest('Only reported life events can be acknowledged')

        await repo.acknowledgeLifeEvent(q, id, req.ctx.userId)
        const updated = await repo.getLifeEvent(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'benefits.life_event.acknowledged',
          entityType: 'life_event',
          entityId: id,
          before: { status: event.status },
          after: { status: 'acknowledged' },
        })
        return updated
      })
    },
  )

  // ── GET /benefits/my-elections ────────────────────────────────────────────
  fastify.get(
    '/benefits/my-elections',
    { preHandler: [authenticate] },
    async (req) => {
      const employeeId = req.ctx.employeeId
      if (!employeeId) throw httpError.forbidden('No employee record linked to this account')
      return db.tenant(req.ctx.tenantId, (q) => repo.getMyElections(q, employeeId))
    },
  )
}
