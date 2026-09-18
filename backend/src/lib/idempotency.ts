import type { Q } from '../db/index.js'
import { newId } from '../db/index.js'
import { sha256Hex } from './crypto.js'
import { httpError } from '../http/errors.js'

export interface IdempotentResult {
  status: number
  body: unknown
}

export const IDEMPOTENCY_KEY_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Runs a mutating handler once per (tenant, key). Replays the stored response
 * for duplicate keys, or 409s when the same key is reused with a different body.
 * Must be called inside a tenant-scoped transaction (`db.tenant`).
 */
export async function useIdempotency(
  q: Q,
  tenantId: string,
  key: string | undefined,
  body: unknown,
  handler: () => Promise<IdempotentResult>,
): Promise<IdempotentResult> {
  if (!key) return handler()

  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw httpError.badRequest('Idempotency-Key must be a UUID')
  }

  const bodyHash = sha256Hex(typeof body === 'string' ? body : JSON.stringify(body ?? {}))

  const inserted = await q.query<{ id: string }>(
    `INSERT INTO idempotency_keys (id, tenant_id, key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, key) DO NOTHING
     RETURNING id`,
    [newId(), tenantId, key, bodyHash],
  )

  if (inserted.rows.length === 1) {
    const result = await handler()
    await q.exec(
      `UPDATE idempotency_keys
       SET response_status = $1, response_body = $2::jsonb, completed_at = now()
       WHERE tenant_id = $3 AND key = $4`,
      [result.status, JSON.stringify(result.body), tenantId, key],
    )
    return result
  }

  const stored = await q.query<{ request_hash: string; response_status: number | null; response_body: unknown }>(
    `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`,
    [tenantId, key],
  )

  const row = stored.rows[0]
  if (row && row.request_hash !== bodyHash) {
    throw httpError.conflict('Idempotency-Key was already used with a different request')
  }
  if (row && row.response_status != null) {
    return { status: row.response_status, body: row.response_body }
  }
  throw httpError.conflict('Request is already being processed')
}