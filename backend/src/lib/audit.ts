import type { Q } from '../db/index.js'
import { newId } from '../db/index.js'

export interface AuditEntry {
  tenantId: string
  actorType: 'user' | 'ai_agent' | 'system'
  actorId: string | null
  action: string
  entityType: string
  entityId: string
  before?: unknown
  after?: unknown
  ip?: string | null
}

/** Append-only event log. Insert-only at the DB level (see db/schema.ts). */
export async function audit(q: Q, entry: AuditEntry): Promise<void> {
  await q.exec(
    `INSERT INTO audit_logs
       (id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, before_state, after_state, ip_address, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::inet, now())`,
    [
      newId(),
      entry.tenantId,
      entry.actorType,
      entry.actorId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.before == null ? null : JSON.stringify(entry.before),
      entry.after == null ? null : JSON.stringify(entry.after),
      entry.ip ?? null,
    ],
  )
}