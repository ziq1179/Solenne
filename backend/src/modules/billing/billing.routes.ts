import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { audit } from '../../lib/audit.js'
import { PERMISSIONS } from '../permissions.js'
import * as repo from './billing.repo.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const setPlanSchema = z.object({
  plan: z.enum(repo.PLAN_NAMES as [string, ...string[]]),
})

/** Returns a valid YYYY-MM-DD (defaults to today when absent/malformed). */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function registerBillingRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  fastify.get(
    '/billing/subscription',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BILLING_READ)] },
    async (req) => {
      return db.tenant(req.ctx.tenantId, (q) => repo.getSubscription(q, req.ctx.tenantId))
    },
  )

  fastify.patch(
    '/billing/subscription/plan',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BILLING_WRITE)] },
    async (req, reply) => {
      const parsed = setPlanSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid plan payload', parsed.error.flatten())
      const tenantId = req.ctx.tenantId

      const result = await db.tenant(tenantId, async (q) => {
        const before = await repo.getSubscription(q, tenantId)
        const after = await repo.setPlan(q, tenantId, parsed.data.plan)
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'billing.plan_changed',
          entityType: 'subscription',
          entityId: after.id,
          before,
          after,
          ip: req.ip,
        })
        return { status: 200, body: after }
      })
      return reply.code(result.status).send(result.body)
    },
  )

  fastify.get(
    '/billing/usage',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.BILLING_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const from = qs.from && DATE_RE.test(qs.from) ? qs.from : today()
      const to = qs.to && DATE_RE.test(qs.to) ? qs.to : today()
      if (from > to) throw httpError.badRequest('"from" must not be after "to"')
      const metric = qs.metric && /^[a-z][a-z0-9_]*$/.test(qs.metric) ? qs.metric : undefined
      return db.tenant(req.ctx.tenantId, (q) => repo.usageSummary(q, req.ctx.tenantId, from, to, metric))
    },
  )
}

export type { Subscription, UsageRow } from './billing.repo.js'
export { PLAN_SEAT_LIMITS, PLAN_NAMES } from './billing.repo.js'