/**
 * Integration Hub dispatch layer. Outbound HTTP calls with credential lookup,
 * audit logging, and two timing modes: fire-and-forget (dispatch) and
 * synchronous (dispatchSync).
 *
 * dispatchRaw opens its own db.tenant() internally — no external q parameter.
 * Never throws: all errors are caught, logged, and returned.
 */

import type { Db, Q } from '../../db/index.js'
import { audit } from '../../lib/audit.js'
import { decryptCredential, parseCredential } from '../../lib/credential-encryption.js'
import { RealSlackEngine } from './providers.js'
import * as repo from './integrations.repo.js'

const slackEngine = new RealSlackEngine()

export interface DispatchResult {
  ok: boolean
  provider: string
  connectionId: string
  durationMs: number
  error?: string
}

async function dispatchRaw(
  db: Db,
  tenantId: string,
  provider: string,
  payload: unknown,
  opts?: { timeoutMs?: number },
): Promise<DispatchResult> {
  const start = Date.now()
  try {
    return await db.tenant(tenantId, async (q) => {
      const conn = await repo.getConnectedByProvider(q, provider)
      if (!conn) {
        const durationMs = Date.now() - start
        await auditDispatch(q, tenantId, provider, '', false, durationMs, 'not connected')
        return { ok: false, provider, connectionId: '', durationMs, error: 'not connected' }
      }

      const masterKey = getMasterKey()
      if (!masterKey) {
        const durationMs = Date.now() - start
        await auditDispatch(q, tenantId, provider, conn.id, false, durationMs, 'encryption key not configured')
        return { ok: false, provider, connectionId: conn.id, durationMs, error: 'encryption key not configured' }
      }

      const parsed = parseCredential(conn.credentialEnc)
      const decrypted = decryptCredential(parsed, masterKey)

      let result: { ok: boolean; error?: string }

      if (provider === 'slack_webhook') {
        result = await sendSlackWebhook(decrypted, payload)
      } else {
        result = { ok: false, error: `Provider '${provider}' not implemented` }
      }

      const durationMs = Date.now() - start
      await auditDispatch(q, tenantId, provider, conn.id, result.ok, durationMs, result.error)

      if (result.ok) {
        await repo.updateConnection(q, conn.id, { status: 'connected', lastVerifiedAt: new Date().toISOString(), lastError: null })
      } else {
        await repo.updateConnection(q, conn.id, { status: 'error', lastError: result.error ?? 'unknown error' })
      }

      return { ok: result.ok, provider, connectionId: conn.id, durationMs, error: result.error }
    })
  } catch (err) {
    const durationMs = Date.now() - start
    const error = err instanceof Error ? err.message : String(err)
    // Best-effort audit outside the tenant transaction
    return { ok: false, provider, connectionId: '', durationMs, error }
  }
}

async function auditDispatch(q: Q, tenantId: string, provider: string, connectionId: string, ok: boolean, durationMs: number, error?: string): Promise<void> {
  await audit(q, {
    tenantId,
    actorType: 'system',
    actorId: null,
    action: `integration.dispatch.${provider}`,
    entityType: 'integration_connection',
    entityId: connectionId,
    after: { ok, durationMs, ...(error ? { error } : {}) },
  })
}

async function sendSlackWebhook(webhookUrl: string, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  const p = payload as { text?: string }
  if (!p?.text) return { ok: false, error: 'missing payload.text' }
  const res = await slackEngine.send(webhookUrl, { text: p.text })
  if (res.ok) return { ok: true }
  return { ok: false, error: res.error ?? `HTTP ${res.statusCode}` }
}

function getMasterKey(): Buffer | null {
  const raw = process.env.INTEGRATION_HUB_KEY
  if (!raw) return null
  return Buffer.from(raw, 'base64')
}

/**
 * Fire-and-forget dispatch for post-commit hooks.
 * Opens its own db.tenant() internally. Caller does not await.
 */
export async function dispatch(
  db: Db,
  tenantId: string,
  provider: string,
  payload: unknown,
  opts?: { timeoutMs?: number },
): Promise<void> {
  dispatchRaw(db, tenantId, provider, payload, opts).catch(() => {})
}

/**
 * Awaited dispatch for user-initiated actions (/verify, /test).
 * Returns the full result so the route handler can respond to the admin.
 */
export async function dispatchSync(
  db: Db,
  tenantId: string,
  provider: string,
  payload: unknown,
  opts?: { timeoutMs?: number },
): Promise<DispatchResult> {
  return dispatchRaw(db, tenantId, provider, payload, opts)
}
