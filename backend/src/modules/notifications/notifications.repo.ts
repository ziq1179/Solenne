import type { Q, Row } from '../../db/index.js'
import { newId } from '../../db/index.js'

export interface Notification {
  id: string
  type: string
  title: string
  body: string | null
  entityType: string
  entityId: string
  isRead: boolean
  createdAt: string
}

interface NotificationRow extends Row {
  id: string
  type: string
  title: string
  body: string | null
  entityType: string
  entityId: string
  isRead: boolean
  createdAt: string
}

const COLS = `
  n.id, n.type, n.title, n.body,
  n.entity_type AS "entityType", n.entity_id AS "entityId",
  n.is_read AS "isRead", n.created_at::text AS "createdAt"`

function map(row: NotificationRow): Notification {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    entityType: row.entityType,
    entityId: row.entityId,
    isRead: row.isRead,
    createdAt: row.createdAt,
  }
}

export interface NotifyInput {
  tenantId: string
  recipientUserId: string
  type: string
  title: string
  body?: string | null
  entityType: string
  entityId: string
}

export interface NotificationFilter {
  unreadOnly?: boolean
  type?: string
}

/**
 * Emits a notification for ONE user account. Must be called inside the same
 * tenant transaction as the domain event it announces, so a rolled-back event
 * can never leave a stray notification behind.
 */
export async function notify(q: Q, input: NotifyInput): Promise<void> {
  await q.exec(
    `INSERT INTO notifications
       (id, tenant_id, recipient_user_id, type, title, body, entity_type, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newId(),
      input.tenantId,
      input.recipientUserId,
      input.type,
      input.title,
      input.body ?? null,
      input.entityType,
      input.entityId,
    ],
  )
}

/** Resolves the user account linked to an employee (null when the employee has no login). */
export async function userAccountIdForEmployee(q: Q, employeeId: string): Promise<string | null> {
  const res = await q.query<{ userId: string | null }>(
    `SELECT user_account_id AS "userId" FROM employees WHERE id = $1`,
    [employeeId],
  )
  return res.rows[0]?.userId ?? null
}

/** Resolves the user account of the manager who approves an employee's requests. */
export async function managerUserAccountId(q: Q, employeeId: string): Promise<string | null> {
  const res = await q.query<{ managerUserId: string | null }>(
    `SELECT m.user_account_id AS "managerUserId"
     FROM employees e JOIN employees m ON m.id = e.manager_employee_id
     WHERE e.id = $1`,
    [employeeId],
  )
  return res.rows[0]?.managerUserId ?? null
}

/** Lists the authenticated user's own notifications (self-scoped by recipient). */
export async function listNotifications(
  q: Q,
  recipientUserId: string,
  filter: { unreadOnly?: boolean; type?: string },
  page: number,
  pageSize: number,
): Promise<{ data: Notification[]; total: number }> {
  const conds = [`n.recipient_user_id = $1`]
  const params: unknown[] = [recipientUserId]
  if (filter.unreadOnly) {
    params.push(false)
    conds.push(`n.is_read = $${params.length}`)
  }
  if (filter.type) {
    params.push(filter.type)
    conds.push(`n.type = $${params.length}`)
  }
  const where = conds.join(' AND ')

  const totalRes = await q.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM notifications n WHERE ${where}`,
    params,
  )
  const total = totalRes.rows[0]?.total ?? 0

  const offset = (page - 1) * pageSize
  const dataRes = await q.query<NotificationRow>(
    `SELECT ${COLS} FROM notifications n WHERE ${where}
     ORDER BY n.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  )
  return { data: dataRes.rows.map(map), total }
}

/** Unread count for the notification badge (self-scoped). */
export async function countUnread(q: Q, recipientUserId: string): Promise<number> {
  const res = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = $1 AND is_read = false`,
    [recipientUserId],
  )
  return res.rows[0]?.n ?? 0
}

/** Marks one of the user's OWN notifications as read. Returns the id when it existed. */
export async function markRead(q: Q, recipientUserId: string, notificationId: string): Promise<string | null> {
  const res = await q.query<{ id: string }>(
    `UPDATE notifications
     SET is_read = true, read_at = now(), updated_at = now()
     WHERE id = $1 AND recipient_user_id = $2
     RETURNING id`,
    [notificationId, recipientUserId],
  )
  return res.rows[0]?.id ?? null
}

/** Marks ALL of the user's own notifications as read. Returns the number updated. */
export async function markAllRead(q: Q, recipientUserId: string): Promise<number> {
  const res = await q.query<{ id: string }>(
    `UPDATE notifications
     SET is_read = true, read_at = now(), updated_at = now()
     WHERE recipient_user_id = $1 AND is_read = false
     RETURNING id`,
    [recipientUserId],
  )
  return res.rows.length
}