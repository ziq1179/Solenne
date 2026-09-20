import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { PERMISSIONS } from '../permissions.js'
import * as repo from './notifications.repo.js'

const NOTIFICATION_TYPE_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/

function pagination(qs: Record<string, string | undefined>) {
  return {
    page: Math.max(1, Number(qs.page ?? 1)),
    pageSize: Math.min(100, Math.max(1, Number(qs.pageSize ?? 25))),
  }
}

export function registerNotificationsRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  fastify.get(
    '/notifications',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.NOTIFICATIONS_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const { page, pageSize } = pagination(qs)
      const filter: repo.NotificationFilter = {
        unreadOnly: qs.unread === 'true',
        type: qs.type && NOTIFICATION_TYPE_RE.test(qs.type) ? qs.type : undefined,
      }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const { data, total } = await repo.listNotifications(q, req.ctx.userId, filter, page, pageSize)
        return { data, page, pageSize, total }
      })
    },
  )

  fastify.get(
    '/notifications/unread-count',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.NOTIFICATIONS_READ)] },
    async (req) => {
      return db.tenant(req.ctx.tenantId, (q) => repo.countUnread(q, req.ctx.userId))
    },
  )

  fastify.patch(
    '/notifications/:notificationId/read',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.NOTIFICATIONS_READ)] },
    async (req, reply) => {
      const notificationId = (req.params as { notificationId: string }).notificationId
      const updated = await db.tenant(req.ctx.tenantId, (q) =>
        repo.markRead(q, req.ctx.userId, notificationId),
      )
      if (!updated) throw httpError.notFound('Notification not found')
      return reply.send({ id: updated })
    },
  )

  fastify.post(
    '/notifications/read-all',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.NOTIFICATIONS_READ)] },
    async (req) => {
      const updated = await db.tenant(req.ctx.tenantId, (q) => repo.markAllRead(q, req.ctx.userId))
      return { updated }
    },
  )
}

// JSON request bodies for read-all / mark-read carry no payload; the routes
// above accept an optional empty body. Document schemas are in the OpenAPI.

export type { Notification } from './notifications.repo.js'
export { notify, userAccountIdForEmployee } from './notifications.repo.js'