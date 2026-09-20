import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { useIdempotency } from '../../lib/idempotency.js'
import { audit } from '../../lib/audit.js'
import { newId } from '../../db/index.js'
import { PERMISSIONS } from '../permissions.js'
import * as employeesRepo from '../employees/employees.repo.js'
import * as repo from './onboarding.repo.js'

const taskInputSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.enum(repo.TEMPLATE_TASK_CATEGORIES).default('general'),
  position: z.number().int().min(0).optional(),
  optional: z.boolean().default(false),
})

const templateCreateSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(repo.PLAN_KINDS),
  description: z.string().max(2000).optional(),
  isDefault: z.boolean().default(false),
  tasks: z.array(taskInputSchema).max(100).default([]),
})

const templatePatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  kind: z.enum(repo.PLAN_KINDS).optional(),
  description: z.string().max(2000).nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

const taskPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  category: z.enum(repo.TEMPLATE_TASK_CATEGORIES).optional(),
  position: z.number().int().min(0).optional(),
  optional: z.boolean().optional(),
})

const planCreateSchema = z.object({
  employeeId: z.string().uuid(),
  templateId: z.string().uuid(),
})

const taskStatusSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
  notes: z.string().max(2000).nullable().optional(),
})

const planFilterSchema = z.object({
  kind: z.enum(repo.PLAN_KINDS).optional(),
  status: z.enum(repo.PLAN_STATUSES).optional(),
  employeeId: z.string().uuid().optional(),
})

function pagination(qs: Record<string, string | undefined>) {
  return {
    page: Math.max(1, Number(qs.page ?? 1)),
    pageSize: Math.min(100, Math.max(1, Number(qs.pageSize ?? 25))),
  }
}

export function registerOnboardingRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  // --- Templates ------------------------------------------------------------

  fastify.get(
    '/onboarding/templates',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const { page, pageSize } = pagination(qs)
      const filter: repo.TemplateFilter = {
        kind: qs.kind === 'onboarding' || qs.kind === 'offboarding' ? qs.kind : undefined,
        defaultOnly: qs.defaultOnly === 'true',
        includeInactive: qs.includeInactive === 'true',
      }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const { data, total } = await repo.listTemplates(q, filter, page, pageSize)
        return { data, page, pageSize, total }
      })
    },
  )

  fastify.post(
    '/onboarding/templates',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_WRITE)] },
    async (req, reply) => {
      const parsed = templateCreateSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid template payload', parsed.error.flatten())
      const tenantId = req.ctx.tenantId
      const key = req.headers['idempotency-key'] as string | undefined

      const result = await db.tenant(tenantId, async (q) =>
        useIdempotency(q, tenantId, key, req.body, async () => {
          const template = await repo.createTemplate(q, {
            id: newId(),
            tenantId,
            name: parsed.data.name,
            kind: parsed.data.kind,
            description: parsed.data.description ?? null,
            isDefault: parsed.data.isDefault,
            createdBy: req.ctx.userId,
            tasks: parsed.data.tasks,
          })
          await audit(q, {
            tenantId,
            actorType: 'user',
            actorId: req.ctx.userId,
            action: 'onboarding.template_created',
            entityType: 'onboarding_template',
            entityId: template.id,
            after: template,
            ip: req.ip,
          })
          return { status: 201, body: template }
        }),
      )
      return reply.code(result.status).send(result.body)
    },
  )

  fastify.get(
    '/onboarding/templates/:templateId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_READ)] },
    async (req, reply) => {
      const templateId = (req.params as { templateId: string }).templateId
      return db.tenant(req.ctx.tenantId, async (q) => {
        const template = await repo.getTemplate(q, templateId)
        if (!template) throw httpError.notFound('Template not found')
        return reply.send(template)
      })
    },
  )

  fastify.patch(
    '/onboarding/templates/:templateId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_WRITE)] },
    async (req, reply) => {
      const parsed = templatePatchSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid template payload', parsed.error.flatten())
      const templateId = (req.params as { templateId: string }).templateId
      const tenantId = req.ctx.tenantId

      await db.tenant(tenantId, async (q) => {
        const before = await repo.getTemplate(q, templateId)
        if (!before) throw httpError.notFound('Template not found')
        const after = await repo.updateTemplateFields(q, templateId, parsed.data as Record<string, unknown>)
        if (!after) throw httpError.notFound('Template not found')
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'onboarding.template_updated',
          entityType: 'onboarding_template',
          entityId: templateId,
          before,
          after,
          ip: req.ip,
        })
      })
      return reply.send(await db.tenant(tenantId, (q) => repo.getTemplate(q, templateId)))
    },
  )

  fastify.delete(
    '/onboarding/templates/:templateId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_WRITE)] },
    async (req, reply) => {
      const templateId = (req.params as { templateId: string }).templateId
      const tenantId = req.ctx.tenantId
      await db.tenant(tenantId, async (q) => {
        const before = await repo.getTemplate(q, templateId)
        if (!before) throw httpError.notFound('Template not found')
        await repo.softDeleteTemplate(q, templateId)
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'onboarding.template_deleted',
          entityType: 'onboarding_template',
          entityId: templateId,
          before,
          ip: req.ip,
        })
      })
      return reply.code(204).send()
    },
  )

  fastify.post(
    '/onboarding/templates/:templateId/tasks',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_WRITE)] },
    async (req, reply) => {
      const parsed = taskInputSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid task payload', parsed.error.flatten())
      const templateId = (req.params as { templateId: string }).templateId
      const tenantId = req.ctx.tenantId

      const task = await db.tenant(tenantId, async (q) => {
        const template = await repo.getTemplate(q, templateId)
        if (!template) throw httpError.notFound('Template not found')
        return repo.addTemplateTask(q, templateId, tenantId, parsed.data)
      })
      return reply.code(201).send(task)
    },
  )

  fastify.patch(
    '/onboarding/templates/:templateId/tasks/:taskId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_WRITE)] },
    async (req, reply) => {
      const parsed = taskPatchSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid task payload', parsed.error.flatten())
      const { templateId, taskId } = req.params as { templateId: string; taskId: string }
      const tenantId = req.ctx.tenantId

      const task = await db.tenant(tenantId, async (q) => {
        const template = await repo.getTemplate(q, templateId)
        if (!template) throw httpError.notFound('Template not found')
        const updated = await repo.updateTemplateTask(q, templateId, taskId, parsed.data as Record<string, unknown>)
        if (!updated) throw httpError.notFound('Task not found')
        return updated
      })
      return reply.send(task)
    },
  )

  fastify.delete(
    '/onboarding/templates/:templateId/tasks/:taskId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_WRITE)] },
    async (req, reply) => {
      const { templateId, taskId } = req.params as { templateId: string; taskId: string }
      const tenantId = req.ctx.tenantId
      await db.tenant(tenantId, async (q) => {
        const template = await repo.getTemplate(q, templateId)
        if (!template) throw httpError.notFound('Template not found')
        await repo.removeTemplateTask(q, templateId, taskId)
      })
      return reply.code(204).send()
    },
  )

  // --- Plans ----------------------------------------------------------------

  fastify.get(
    '/onboarding/plans',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const { page, pageSize } = pagination(qs)
      const parsed = planFilterSchema.safeParse(qs)
      const filter = parsed.success ? parsed.data : {}
      return db.tenant(req.ctx.tenantId, async (q) => {
        const { data, total } = await repo.listPlans(q, filter as repo.PlanFilter, page, pageSize)
        return { data, page, pageSize, total }
      })
    },
  )

  fastify.post(
    '/onboarding/plans',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_WRITE)] },
    async (req, reply) => {
      const parsed = planCreateSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid plan payload', parsed.error.flatten())
      const tenantId = req.ctx.tenantId
      const key = req.headers['idempotency-key'] as string | undefined

      const result = await db.tenant(tenantId, async (q) =>
        useIdempotency(q, tenantId, key, req.body, async () => {
          const employee = await employeesRepo.getEmployeeById(q, parsed.data.employeeId)
          if (!employee) throw httpError.notFound('Employee not found')
          const template = await repo.getTemplate(q, parsed.data.templateId)
          if (!template) throw httpError.notFound('Template not found')

          const plan = await repo.startPlan(q, {
            id: newId(),
            tenantId,
            employeeId: employee.id,
            kind: template.kind as 'onboarding' | 'offboarding',
            templateId: template.id,
            source: 'manual',
            createdBy: req.ctx.userId,
          })
          await audit(q, {
            tenantId,
            actorType: 'user',
            actorId: req.ctx.userId,
            action: `onboarding.${template.kind}_started`,
            entityType: 'onboarding_plan',
            entityId: plan.id,
            after: plan,
            ip: req.ip,
          })
          return { status: 201, body: plan }
        }),
      )
      return reply.code(result.status).send(result.body)
    },
  )

  fastify.get(
    '/onboarding/plans/:planId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_READ)] },
    async (req, reply) => {
      const planId = (req.params as { planId: string }).planId
      return db.tenant(req.ctx.tenantId, async (q) => {
        const plan = await repo.getPlan(q, planId)
        if (!plan) throw httpError.notFound('Plan not found')
        return reply.send(plan)
      })
    },
  )

  fastify.patch(
    '/onboarding/plans/:planId/tasks/:taskId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_WRITE)] },
    async (req, reply) => {
      const parsed = taskStatusSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid plan task payload', parsed.error.flatten())
      const { planId, taskId } = req.params as { planId: string; taskId: string }
      const tenantId = req.ctx.tenantId

      const task = await db.tenant(tenantId, async (q) => {
        const before = await repo.getPlan(q, planId)
        if (!before) throw httpError.notFound('Plan not found')
        if (before.status !== 'in_progress') {
          throw httpError.conflict(`A ${before.status} plan cannot change tasks`)
        }
        const updated = await repo.updatePlanTask(q, tenantId, planId, taskId, {
          status: parsed.data.status,
          notes: parsed.data.notes ?? null,
          completedBy: req.ctx.userId,
        })
        if (!updated) throw httpError.notFound('Plan task not found')
        return updated
      })
      const plan = await db.tenant(tenantId, (q) => repo.getPlan(q, planId))
      return reply.send({ ...plan, task })
    },
  )

  fastify.post(
    '/onboarding/plans/:planId/cancel',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ONBOARDING_WRITE)] },
    async (req, reply) => {
      const planId = (req.params as { planId: string }).planId
      const tenantId = req.ctx.tenantId
      const plan = await db.tenant(tenantId, async (q) => {
        const before = await repo.getPlan(q, planId)
        if (!before) throw httpError.notFound('Plan not found')
        if (before.status !== 'in_progress') {
          throw httpError.conflict(`A ${before.status} plan cannot be cancelled`)
        }
        const cancelled = await repo.cancelPlan(q, planId, tenantId)
        if (!cancelled) throw httpError.notFound('Plan not found')
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: `onboarding.${cancelled.kind}_cancelled`,
          entityType: 'onboarding_plan',
          entityId: planId,
          before,
          after: cancelled,
          ip: req.ip,
        })
        return cancelled
      })
      return reply.send(plan)
    },
  )
}

export type { OnboardingTemplate, OnboardingTemplateDetail, OnboardingPlan, OnboardingPlanDetail, PlanTask, TemplateTask } from './onboarding.repo.js'
export { PLAN_KINDS, PLAN_STATUSES, TASK_STATUSES, TEMPLATE_TASK_CATEGORIES } from './onboarding.repo.js'