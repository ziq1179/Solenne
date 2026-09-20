import type { FastifyInstance } from 'fastify'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { PERMISSIONS } from '../permissions.js'
import * as repo from './reports.repo.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EMPLOYMENT_STATUSES = ['active', 'on_leave', 'terminated'] as const

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export function registerReportRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  fastify.get(
    '/reports/headcount',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.REPORTING_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const status =
        qs.status && (EMPLOYMENT_STATUSES as readonly string[]).includes(qs.status) ? qs.status : 'active'
      return db.tenant(req.ctx.tenantId, (q) => repo.headcount(q, status))
    },
  )

  fastify.get(
    '/reports/attendance-summary',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.REPORTING_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const from = qs.from && DATE_RE.test(qs.from) ? qs.from : todayUtc()
      const to = qs.to && DATE_RE.test(qs.to) ? qs.to : todayUtc()
      if (from > to) throw httpError.badRequest('"from" must not be after "to"')
      return db.tenant(req.ctx.tenantId, (q) => repo.attendanceSummary(q, from, to))
    },
  )

  fastify.get(
    '/reports/leave-summary',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.REPORTING_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const currentYear = new Date().getUTCFullYear()
      const parsed = parseInt(qs.year ?? '', 10)
      const year = Number.isInteger(parsed) && parsed >= 2000 && parsed <= 2100 ? parsed : currentYear
      return db.tenant(req.ctx.tenantId, (q) => repo.leaveSummary(q, year))
    },
  )
}