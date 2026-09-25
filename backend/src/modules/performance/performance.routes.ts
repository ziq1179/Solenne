import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { audit } from '../../lib/audit.js'
import { PERMISSIONS } from '../permissions.js'
import * as repo from './performance.repo.js'

const createGoalSchema = z.object({
  employeeId: z.string().uuid().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z.string().max(50).optional(),
  goalType: z.enum(['okr', 'kpi', 'custom']).optional(),
  targetValue: z.number().optional(),
  percentage: z.number().min(0).max(100).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

const updateGoalSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(50).optional(),
  percentage: z.number().min(0).max(100).optional(),
  currentValue: z.number().optional(),
  targetValue: z.number().optional(),
  status: z.enum(['active', 'completed', 'abandoned']).optional(),
})

const createCycleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reviewDeadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

const cycleStatusSchema = z.object({
  status: z.enum(['active', 'collecting', 'calibration', 'finalized']),
})

const mapGoalSchema = z.object({
  goalId: z.string().uuid(),
})

const selfReviewSchema = z.object({
  rating: z.number().min(1).max(5),
  comment: z.string().max(5000),
})

const managerReviewSchema = z.object({
  rating: z.number().min(1).max(5),
  comment: z.string().max(5000),
})

const finalizeReviewSchema = z.object({
  finalRating: z.number().min(1).max(5),
})

const createFeedbackSchema = z.object({
  recipientId: z.string().uuid(),
  cycleId: z.string().uuid().optional(),
  content: z.string().min(1).max(5000),
  feedbackType: z.enum(['general', 'kudos', 'coaching', 'peer']).optional(),
})

function isManagerScoped(roles: string[]): boolean {
  return roles.includes('manager') && !roles.includes('admin') && !roles.includes('hr_manager')
}

export function registerPerformanceRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  // ── GET /performance/goals ───────────────────────────────────────────────
  fastify.get(
    '/performance/goals',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const page = Number(qs.page) || 1
      const pageSize = Number(qs.pageSize) || 25
      return db.tenant(req.ctx.tenantId, (q) => {
        if (isManagerScoped(req.ctx.roles)) {
          if (!req.ctx.employeeId) throw httpError.forbidden('No employee record linked to this account')
          return repo.listGoals(q, { managerEmployeeId: req.ctx.employeeId, page, pageSize })
        }
        // Admin/hr_manager see all; employees see only their own
        if (req.ctx.roles.includes('employee') && !req.ctx.roles.includes('admin') && !req.ctx.roles.includes('hr_manager')) {
          if (!req.ctx.employeeId) throw httpError.forbidden('No employee record linked to this account')
          return repo.listGoals(q, { employeeId: req.ctx.employeeId, page, pageSize })
        }
        return repo.listGoals(q, { page, pageSize })
      })
    },
  )

  // ── POST /performance/goals ──────────────────────────────────────────────
  fastify.post(
    '/performance/goals',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_WRITE)] },
    async (req) => {
      const parsed = createGoalSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        // Employees can only create goals for themselves; admin/hr_manager can specify another employee
        let employeeId: string | undefined = parsed.data.employeeId
        if (!employeeId) {
          employeeId = req.ctx.employeeId ?? undefined
        } else if (isManagerScoped(req.ctx.roles)) {
          throw httpError.forbidden('Managers cannot create goals for other employees')
        }
        if (!employeeId) throw httpError.forbidden('No employee record linked to this account')

        const goal = await repo.createGoal(q, { ...parsed.data, employeeId, createdBy: req.ctx.userId })
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'performance.goal.created',
          entityType: 'goal',
          entityId: goal.id,
          after: goal,
        })
        return goal
      })
    },
  )

  // ── PATCH /performance/goals/:id ─────────────────────────────────────────
  fastify.patch(
    '/performance/goals/:id',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      const parsed = updateGoalSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const existing = await repo.getGoal(q, id)
        if (!existing) throw httpError.notFound('Goal not found')
        // Employees can only edit their own goals
        if (isManagerScoped(req.ctx.roles) && existing.employeeId !== req.ctx.employeeId) {
          throw httpError.forbidden('You can only edit your own goals')
        }
        const before = { ...existing }
        await repo.updateGoal(q, id, parsed.data)
        const after = await repo.getGoal(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'performance.goal.updated',
          entityType: 'goal',
          entityId: id,
          before,
          after,
        })
        return after
      })
    },
  )

  // ── GET /performance/cycles ──────────────────────────────────────────────
  fastify.get(
    '/performance/cycles',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const status = qs.status
      const page = Number(qs.page) || 1
      const pageSize = Number(qs.pageSize) || 25
      return db.tenant(req.ctx.tenantId, (q) => repo.listReviewCycles(q, { status, page, pageSize }))
    },
  )

  // ── POST /performance/cycles ─────────────────────────────────────────────
  fastify.post(
    '/performance/cycles',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_WRITE)] },
    async (req) => {
      const parsed = createCycleSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        let cycle
        try {
          cycle = await repo.createReviewCycle(q, { ...parsed.data, createdBy: req.ctx.userId })
        } catch (err: any) {
          if (err.code === '23505') throw httpError.conflict('A review cycle with this name already exists')
          throw err
        }
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'performance.cycle.created',
          entityType: 'review_cycle',
          entityId: cycle.id,
          after: cycle,
        })
        return cycle
      })
    },
  )

  // ── POST /performance/cycles/:id/status ──────────────────────────────────
  fastify.post(
    '/performance/cycles/:id/status',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      const parsed = cycleStatusSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const cycle = await repo.getReviewCycle(q, id)
        if (!cycle) throw httpError.notFound('Review cycle not found')

        const validTransitions: Record<string, string[]> = {
          draft: ['active'],
          active: ['collecting'],
          collecting: ['calibration'],
          calibration: ['finalized'],
        }
        const allowed = validTransitions[cycle.status]
        if (!allowed || !allowed.includes(parsed.data.status)) {
          throw httpError.badRequest(`Cannot transition from '${cycle.status}' to '${parsed.data.status}'`)
        }

        const extra = parsed.data.status === 'finalized' ? { finalizedBy: req.ctx.userId } : undefined
        await repo.updateReviewCycleStatus(q, id, parsed.data.status, extra)
        const updated = await repo.getReviewCycle(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'performance.cycle.status',
          entityType: 'review_cycle',
          entityId: id,
          before: { status: cycle.status },
          after: { status: parsed.data.status },
        })
        return updated
      })
    },
  )

  // ── POST /performance/cycles/:id/goals ───────────────────────────────────
  fastify.post(
    '/performance/cycles/:id/goals',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      const parsed = mapGoalSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const cycle = await repo.getReviewCycle(q, id)
        if (!cycle) throw httpError.notFound('Review cycle not found')
        const goal = await repo.getGoal(q, parsed.data.goalId)
        if (!goal) throw httpError.notFound('Goal not found')
        // Employees can only map their own goals
        if (isManagerScoped(req.ctx.roles) && goal.employeeId !== req.ctx.employeeId) {
          throw httpError.forbidden('You can only map your own goals to a cycle')
        }
        return repo.mapGoalToCycle(q, id, parsed.data.goalId)
      })
    },
  )

  // ── GET /performance/reviews ─────────────────────────────────────────────
  fastify.get(
    '/performance/reviews',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const cycleId = qs.cycleId
      const page = Number(qs.page) || 1
      const pageSize = Number(qs.pageSize) || 25
      return db.tenant(req.ctx.tenantId, (q) => {
        if (isManagerScoped(req.ctx.roles)) {
          if (!req.ctx.employeeId) throw httpError.forbidden('No employee record linked to this account')
          return repo.listPerformanceReviews(q, { cycleId, managerEmployeeId: req.ctx.employeeId, page, pageSize })
        }
        return repo.listPerformanceReviews(q, { cycleId, page, pageSize })
      })
    },
  )

  // ── GET /performance/reviews/:id ─────────────────────────────────────────
  fastify.get(
    '/performance/reviews/:id',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_READ)] },
    async (req) => {
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const review = await repo.getPerformanceReview(q, id)
        if (!review) throw httpError.notFound('Review not found')
        // Managers can see their direct reports' reviews; employees can only see their own
        if (isManagerScoped(req.ctx.roles)) {
          const isOwn = review.employeeId === req.ctx.employeeId
          const isAssignedManager = review.managerId === req.ctx.employeeId
          if (!isOwn && !isAssignedManager) {
            throw httpError.forbidden('Access denied')
          }
        }
        // If caller is the employee and review is not finalized, hide manager fields
        if (review.employeeId === req.ctx.employeeId && review.status !== 'finalized') {
          const { managerRating, managerComment, managerSubmittedAt, ...safe } = review as any
          return safe
        }
        return review
      })
    },
  )

  // ── POST /performance/reviews/:id/self ───────────────────────────────────
  fastify.post(
    '/performance/reviews/:id/self',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      const parsed = selfReviewSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const review = await repo.getPerformanceReview(q, id)
        if (!review) throw httpError.notFound('Review not found')
        if (review.employeeId !== req.ctx.employeeId) throw httpError.forbidden('You can only submit your own self-review')
        if (review.status !== 'draft' && review.status !== 'self_submitted') {
          throw httpError.badRequest('Review is not accepting self-reviews')
        }

        await repo.submitSelfReview(q, id, parsed.data.rating, parsed.data.comment)
        const updated = await repo.getPerformanceReview(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'performance.review.submitted',
          entityType: 'performance_review',
          entityId: id,
          before: { status: review.status },
          after: { status: updated!.status },
        })
        return updated
      })
    },
  )

  // ── POST /performance/reviews/:id/manager ────────────────────────────────
  fastify.post(
    '/performance/reviews/:id/manager',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      const parsed = managerReviewSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const review = await repo.getPerformanceReview(q, id)
        if (!review) throw httpError.notFound('Review not found')
        if (!req.ctx.employeeId) throw httpError.forbidden('No employee record linked to this account')
        // Managers can only review their direct reports
        if (isManagerScoped(req.ctx.roles) && review.managerId !== req.ctx.employeeId) {
          throw httpError.forbidden('You can only review your direct reports')
        }

        await repo.submitManagerReview(q, id, req.ctx.employeeId, parsed.data.rating, parsed.data.comment)
        const updated = await repo.getPerformanceReview(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'performance.review.submitted',
          entityType: 'performance_review',
          entityId: id,
          before: { status: review.status },
          after: { status: updated!.status },
        })
        return updated
      })
    },
  )

  // ── POST /performance/reviews/:id/finalize ──────────────────────────────
  fastify.post(
    '/performance/reviews/:id/finalize',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_APPROVE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      const parsed = finalizeReviewSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const review = await repo.getPerformanceReview(q, id)
        if (!review) throw httpError.notFound('Review not found')
        if (review.status === 'finalized') throw httpError.badRequest('Review is already finalized')

        await repo.finalizeReview(q, id, parsed.data.finalRating, req.ctx.userId)
        const updated = await repo.getPerformanceReview(q, id)
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'performance.review.finalized',
          entityType: 'performance_review',
          entityId: id,
          before: { status: review.status, finalRating: review.finalRating },
          after: { status: 'finalized', finalRating: parsed.data.finalRating },
        })
        return updated
      })
    },
  )

  // ── GET /performance/feedback ────────────────────────────────────────────
  fastify.get(
    '/performance/feedback',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const page = Number(qs.page) || 1
      const pageSize = Number(qs.pageSize) || 25
      return db.tenant(req.ctx.tenantId, (q) => {
        if (isManagerScoped(req.ctx.roles)) {
          if (!req.ctx.employeeId) throw httpError.forbidden('No employee record linked to this account')
          return repo.listFeedbackEntries(q, { managerEmployeeId: req.ctx.employeeId, page, pageSize })
        }
        return repo.listFeedbackEntries(q, { page, pageSize })
      })
    },
  )

  // ── POST /performance/feedback ───────────────────────────────────────────
  fastify.post(
    '/performance/feedback',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.PERFORMANCE_WRITE)] },
    async (req) => {
      const parsed = createFeedbackSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        if (!req.ctx.employeeId) throw httpError.forbidden('No employee record linked to this account')
        const entry = await repo.createFeedbackEntry(q, {
          authorId: req.ctx.employeeId,
          ...parsed.data,
        })
        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'performance.feedback.created',
          entityType: 'feedback_entry',
          entityId: entry.id,
          after: entry,
        })
        return entry
      })
    },
  )

  // ── GET /performance/me ──────────────────────────────────────────────────
  fastify.get(
    '/performance/me',
    { preHandler: [authenticate] },
    async (req) => {
      const employeeId = req.ctx.employeeId
      if (!employeeId) throw httpError.forbidden('No employee record linked to this account')
      return db.tenant(req.ctx.tenantId, (q) => repo.getMyPerformanceData(q, employeeId))
    },
  )
}
