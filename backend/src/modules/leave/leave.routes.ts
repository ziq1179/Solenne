import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { useIdempotency } from '../../lib/idempotency.js'
import { audit } from '../../lib/audit.js'
import { PERMISSIONS } from '../permissions.js'
import * as repo from './leave.repo.js'

const leaveRequestSchema = z.object({
  leaveTypeId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD'),
  reason: z.string().max(500).optional(),
})

const leaveDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  decisionNote: z.string().max(500).optional(),
})

/** Inclusive business-day (Mon–Fri) count between two dates. */
export function businessDays(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    throw httpError.badRequest('endDate must be on or after startDate')
  }
  let days = 0
  const cursor = new Date(start)
  while (cursor <= end) {
    const dow = cursor.getUTCDay()
    if (dow !== 0 && dow !== 6) days++
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

export function registerLeaveRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  fastify.get(
    '/leave-types',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.LEAVE_READ)] },
    async (req) => db.tenant(req.ctx.tenantId, (q) => repo.listLeaveTypes(q)),
  )

  fastify.get(
    '/employees/:employeeId/leave-balances',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.LEAVE_READ)] },
    async (req) => {
      const employeeId = (req.params as { employeeId: string }).employeeId
      const qs = req.query as Record<string, string | undefined>
      const year = Number(qs.year ?? new Date().getFullYear())
      return db.tenant(req.ctx.tenantId, async (q) => {
        if (!req.ctx.isDirectoryRole && employeeId !== req.ctx.employeeId) {
          throw httpError.notFound('Employee not found')
        }
        return repo.listBalances(q, employeeId, year)
      })
    },
  )

  fastify.get(
    '/leave-requests',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.LEAVE_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const page = Math.max(1, Number(qs.page ?? 1))
      const pageSize = Math.min(100, Math.max(1, Number(qs.pageSize ?? 25)))
      const status = qs.status
      const requestedEmployee = qs.employeeId

      return db.tenant(req.ctx.tenantId, async (q) => {
        const filter: { status?: string; employeeId?: string } = { status }
        if (!req.ctx.isDirectoryRole) {
          // Self-service: employees only ever see their own requests.
          filter.employeeId = req.ctx.employeeId ?? '__none__'
        } else if (requestedEmployee) {
          filter.employeeId = requestedEmployee
        }
        const { data, total } = await repo.listLeaveRequests(q, filter, page, pageSize)
        return { data, page, pageSize, total }
      })
    },
  )

  fastify.post(
    '/leave-requests',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.LEAVE_READ)] },
    async (req, reply) => {
      const parsed = leaveRequestSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid leave request', parsed.error.flatten())
      const { leaveTypeId, startDate, endDate, reason } = parsed.data
      const tenantId = req.ctx.tenantId
      const key = req.headers['idempotency-key'] as string | undefined

      if (!req.ctx.employeeId) {
        throw httpError.forbidden('No employee record is linked to this account')
      }

      const result = await db.tenant(tenantId, async (q) =>
        useIdempotency(q, tenantId, key, req.body, async () => {
          const leaveType = await repo.getLeaveType(q, leaveTypeId)
          if (!leaveType) throw httpError.badRequest('Unknown leave type')

          const days = businessDays(startDate, endDate)
          if (days <= 0) throw httpError.badRequest('Leave period contains no working days')

          const balance = await repo.getBalance(q, req.ctx.employeeId!, leaveTypeId, Number(startDate.slice(0, 4)))
          if (!balance || balance.remainingDays < days) {
            throw httpError.unprocessable(
              `Insufficient leave balance (${balance ? balance.remainingDays : 0} day(s) available, ${days} requested)`,
            )
          }

          const request = await repo.insertLeaveRequest(q, {
            tenantId,
            employeeId: req.ctx.employeeId!,
            leaveTypeId,
            startDate,
            endDate,
            daysRequested: days,
            reason,
          })

          await audit(q, {
            tenantId,
            actorType: 'user',
            actorId: req.ctx.userId,
            action: 'leave.requested',
            entityType: 'leave_request',
            entityId: request.id,
            after: request,
            ip: req.ip,
          })
          return { status: 201, body: request }
        }),
      )
      return reply.code(result.status).send(result.body)
    },
  )

  fastify.post(
    '/leave-requests/:requestId/decision',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.LEAVE_APPROVE)] },
    async (req, reply) => {
      const parsed = leaveDecisionSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid decision payload', parsed.error.flatten())
      const requestId = (req.params as { requestId: string }).requestId
      const tenantId = req.ctx.tenantId
      const key = req.headers['idempotency-key'] as string | undefined

      if (!req.ctx.employeeId) {
        throw httpError.forbidden('No employee record is linked to this account')
      }

      const result = await db.tenant(tenantId, async (q) =>
        useIdempotency(q, tenantId, key, req.body, async () => {
          const before = await repo.getLeaveRequest(q, requestId)
          if (!before) throw httpError.notFound('Leave request not found')
          if (before.status !== 'pending') {
            throw httpError.conflict(`Request is already ${before.status}`)
          }

          const request = await repo.decideLeaveRequest(q, requestId, {
            decision: parsed.data.decision,
            decisionNote: parsed.data.decisionNote,
            approverEmployeeId: req.ctx.employeeId!,
          })
          if (!request) throw httpError.conflict('Leave request changed state while being processed')

          if (request.status === 'approved') {
            await repo.incrementUsedDays(
              q,
              request.employeeId,
              request.leaveTypeId,
              Number(request.startDate.slice(0, 4)),
              request.daysRequested,
            )
          }

          await audit(q, {
            tenantId,
            actorType: 'user',
            actorId: req.ctx.userId,
            action: request.status === 'approved' ? 'leave.approved' : 'leave.rejected',
            entityType: 'leave_request',
            entityId: requestId,
            before,
            after: request,
            ip: req.ip,
          })
          return { status: 200, body: request }
        }),
      )
      return reply.code(result.status).send(result.body)
    },
  )

  fastify.get(
    '/audit-logs',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.AUDIT_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const page = Math.max(1, Number(qs.page ?? 1))
      const pageSize = Math.min(100, Math.max(1, Number(qs.pageSize ?? 25)))
      return db.tenant(req.ctx.tenantId, async (q) => {
        const res = await q.query<Record<string, unknown>>(
          `SELECT id, actor_type AS "actorType", actor_id AS "actorId", action,
                  entity_type AS "entityType", entity_id AS "entityId", created_at::text AS "createdAt"
           FROM audit_logs
           ORDER BY created_at DESC
           LIMIT $1 OFFSET $2`,
          [pageSize, (page - 1) * pageSize],
        )
        return { data: res.rows, page, pageSize }
      })
    },
  )
}
