import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { useIdempotency } from '../../lib/idempotency.js'
import { audit } from '../../lib/audit.js'
import { PERMISSIONS } from '../permissions.js'
import { getEmployeeById } from '../employees/employees.repo.js'
import * as repo from './attendance.repo.js'

const clockInSchema = z.object({
  source: z.enum(['web', 'mobile', 'biometric']).default('web'),
  geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
})

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function registerAttendanceRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  fastify.post(
    '/attendance/clock-in',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = clockInSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid clock-in payload', parsed.error.flatten())
      if (!req.ctx.employeeId) throw httpError.forbidden('No employee record is linked to this account')
      const tenantId = req.ctx.tenantId
      const key = req.headers['idempotency-key'] as string | undefined

      const result = await db.tenant(tenantId, async (q) =>
        useIdempotency(q, tenantId, key, req.body, async () => {
          const record = await repo.insertClockIn(q, {
            tenantId,
            employeeId: req.ctx.employeeId!,
            source: parsed.data.source,
            geo: parsed.data.geo,
          })
          if (!record) throw httpError.conflict('Already clocked in')

          await audit(q, {
            tenantId,
            actorType: 'user',
            actorId: req.ctx.userId,
            action: 'attendance.clocked_in',
            entityType: 'attendance_record',
            entityId: record.id,
            after: record,
            ip: req.ip,
          })
          return { status: 201, body: record }
        }),
      )
      return reply.code(result.status).send(result.body)
    },
  )

  fastify.post(
    '/attendance/clock-out',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!req.ctx.employeeId) throw httpError.forbidden('No employee record is linked to this account')
      const tenantId = req.ctx.tenantId
      const key = req.headers['idempotency-key'] as string | undefined

      const result = await db.tenant(tenantId, async (q) =>
        useIdempotency(q, tenantId, key, req.body, async () => {
          const open = await repo.getOpenRecord(q, req.ctx.employeeId!)
          if (!open) throw httpError.notFound('No open clock-in found')

          const record = await repo.closeClockOut(q, open.id)
          if (!record) throw httpError.conflict('Clock-in was already closed')

          await audit(q, {
            tenantId,
            actorType: 'user',
            actorId: req.ctx.userId,
            action: 'attendance.clocked_out',
            entityType: 'attendance_record',
            entityId: record.id,
            before: open,
            after: record,
            ip: req.ip,
          })
          return { status: 200, body: record }
        }),
      )
      return reply.code(result.status).send(result.body)
    },
  )

  fastify.get(
    '/employees/:employeeId/attendance',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATTENDANCE_READ)] },
    async (req) => {
      const employeeId = (req.params as { employeeId: string }).employeeId
      const qs = req.query as Record<string, string | undefined>
      const from = qs.from && DATE_RE.test(qs.from) ? qs.from : undefined
      const to = qs.to && DATE_RE.test(qs.to) ? qs.to : undefined

      return db.tenant(req.ctx.tenantId, async (q) => {
        if (!req.ctx.isDirectoryRole && employeeId !== req.ctx.employeeId) {
          throw httpError.notFound('Employee not found')
        }
        // RLS hides foreign-tenant rows, so resolvability doubles as the
        // tenant-isolation check: a directory user asking about another
        // tenant's employee gets a 404, not an empty list.
        const employee = await getEmployeeById(q, employeeId)
        if (!employee) throw httpError.notFound('Employee not found')
        return repo.listAttendance(q, employeeId, from, to)
      })
    },
  )
}