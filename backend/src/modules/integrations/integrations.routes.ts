import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { audit } from '../../lib/audit.js'
import {
  encryptCredential,
  serializeCredential,
  maskCredential,
} from '../../lib/credential-encryption.js'
import { PERMISSIONS } from '../permissions.js'
import * as repo from './integrations.repo.js'
import { dispatchSync } from './dispatch.js'

const PROVIDERS = [
  'slack_webhook',
  'sso_saml',
  'payroll_partner',
  'accounting',
  'calendar',
  'job_boards',
  'background_check',
] as const

const createConnectionSchema = z.object({
  provider: z.enum(PROVIDERS),
  label: z.string().min(1).max(200),
  credential: z.string().min(1),
  configJson: z.record(z.unknown()).optional(),
})

const updateConnectionSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  credential: z.string().min(1).optional(),
  configJson: z.record(z.unknown()).optional(),
})

export function registerIntegrationsRoutes(fastify: FastifyInstance): void {
  const { db, config } = fastify

  // ── GET /integrations ─────────────────────────────────────────────────────
  fastify.get(
    '/integrations',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.INTEGRATIONS_READ)] },
    async (req) => {
      return db.tenant(req.ctx.tenantId, async (q) => {
        const connections = await repo.listConnections(q)
        return connections.map((c) => ({
          id: c.id,
          provider: c.provider,
          label: c.label,
          status: c.status,
          config: c.configJson,
          maskedCredential: c.maskedPreview,
          lastVerifiedAt: c.lastVerifiedAt,
          lastError: c.lastError,
          createdAt: c.createdAt,
        }))
      })
    },
  )

  // ── GET /integrations/:id ─────────────────────────────────────────────────
  fastify.get(
    '/integrations/:id',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.INTEGRATIONS_READ)] },
    async (req) => {
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const conn = await repo.getConnection(q, id)
        if (!conn) throw httpError.notFound('Integration connection not found')
        return {
          id: conn.id,
          provider: conn.provider,
          label: conn.label,
          status: conn.status,
          config: conn.configJson,
          maskedCredential: conn.maskedPreview,
          lastVerifiedAt: conn.lastVerifiedAt,
          lastError: conn.lastError,
          createdBy: conn.createdBy,
          createdAt: conn.createdAt,
        }
      })
    },
  )

  // ── POST /integrations ────────────────────────────────────────────────────
  fastify.post(
    '/integrations',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.INTEGRATIONS_WRITE)] },
    async (req) => {
      const parsed = createConnectionSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      const masterKey = config.integrationHubKey as Buffer | undefined
      if (!masterKey) throw httpError.badRequest('Integration Hub encryption key not configured (INTEGRATION_HUB_KEY)')

      const keyVersion = config.currentKeyVersion as number
      const encrypted = encryptCredential(parsed.data.credential, masterKey, keyVersion)
      const serialized = serializeCredential(encrypted)
      const masked = maskCredential(parsed.data.credential)

      return db.tenant(req.ctx.tenantId, async (q) => {
        const conn = await repo.createConnection(q, {
          provider: parsed.data.provider,
          label: parsed.data.label,
          credentialEnc: serialized,
          maskedPreview: masked,
          keyVersion,
          configJson: parsed.data.configJson,
          createdBy: req.ctx.userId,
        })

        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'integration.connection.created',
          entityType: 'integration_connection',
          entityId: conn.id,
          after: { provider: conn.provider, label: conn.label, status: conn.status },
        })

        return {
          id: conn.id,
          provider: conn.provider,
          label: conn.label,
          status: conn.status,
          config: conn.configJson,
          maskedCredential: conn.maskedPreview,
          createdAt: conn.createdAt,
        }
      })
    },
  )

  // ── PATCH /integrations/:id ───────────────────────────────────────────────
  fastify.patch(
    '/integrations/:id',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.INTEGRATIONS_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      const parsed = updateConnectionSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      return db.tenant(req.ctx.tenantId, async (q) => {
        const existing = await repo.getConnection(q, id)
        if (!existing) throw httpError.notFound('Integration connection not found')

        const updateInput: repo.UpdateConnectionInput = {}
        if (parsed.data.label !== undefined) updateInput.label = parsed.data.label
        if (parsed.data.configJson !== undefined) updateInput.configJson = parsed.data.configJson

        if (parsed.data.credential !== undefined) {
          const masterKey = config.integrationHubKey as Buffer | undefined
          if (!masterKey) throw httpError.badRequest('Integration Hub encryption key not configured (INTEGRATION_HUB_KEY)')
          const keyVersion = config.currentKeyVersion as number
          const encrypted = encryptCredential(parsed.data.credential, masterKey, keyVersion)
          updateInput.credentialEnc = serializeCredential(encrypted)
          updateInput.maskedPreview = maskCredential(parsed.data.credential)
          updateInput.keyVersion = keyVersion
        }

        const updated = await repo.updateConnection(q, id, updateInput)
        if (!updated) throw httpError.notFound('Integration connection not found')

        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'integration.connection.updated',
          entityType: 'integration_connection',
          entityId: id,
          before: { status: existing.status, label: existing.label },
          after: { status: updated.status, label: updated.label },
        })

        return {
          id: updated.id,
          provider: updated.provider,
          label: updated.label,
          status: updated.status,
          config: updated.configJson,
          maskedCredential: updated.maskedPreview,
          lastVerifiedAt: updated.lastVerifiedAt,
          lastError: updated.lastError,
          updatedAt: updated.updatedAt,
        }
      })
    },
  )

  // ── DELETE /integrations/:id ──────────────────────────────────────────────
  fastify.delete(
    '/integrations/:id',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.INTEGRATIONS_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const existing = await repo.getConnection(q, id)
        if (!existing) throw httpError.notFound('Integration connection not found')

        await repo.deleteConnection(q, id)

        await audit(q, {
          tenantId: req.ctx.tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'integration.connection.deleted',
          entityType: 'integration_connection',
          entityId: id,
          before: { provider: existing.provider, label: existing.label },
        })

        return { deleted: true }
      })
    },
  )

  // ── POST /integrations/:id/verify ─────────────────────────────────────────
  fastify.post(
    '/integrations/:id/verify',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.INTEGRATIONS_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }

      const connection = await db.tenant(req.ctx.tenantId, async (q) => {
        const conn = await repo.getConnection(q, id)
        if (!conn) throw httpError.notFound('Integration connection not found')
        return conn
      })

      const result = await dispatchSync(db, req.ctx.tenantId, connection.provider, {
        text: 'Trellis HRMS — connection verification',
      })

      // Update connection status based on result
      await db.tenant(req.ctx.tenantId, async (q) => {
        if (result.ok) {
          await repo.updateConnection(q, id, {
            status: 'connected',
            lastVerifiedAt: new Date().toISOString(),
            lastError: null,
          })
        } else {
          await repo.updateConnection(q, id, {
            status: 'error',
            lastError: result.error ?? 'verification failed',
          })
        }
      })

      return {
        ok: result.ok,
        provider: result.provider,
        connectionId: result.connectionId,
        durationMs: result.durationMs,
        status: result.ok ? 'connected' : 'error',
        lastVerifiedAt: result.ok ? new Date().toISOString() : null,
        lastError: result.error ?? null,
      }
    },
  )

  // ── POST /integrations/:id/test ───────────────────────────────────────────
  fastify.post(
    '/integrations/:id/test',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.INTEGRATIONS_WRITE)] },
    async (req) => {
      const { id } = req.params as { id: string }

      const connection = await db.tenant(req.ctx.tenantId, async (q) => {
        const conn = await repo.getConnection(q, id)
        if (!conn) throw httpError.notFound('Integration connection not found')
        return conn
      })

      const result = await dispatchSync(db, req.ctx.tenantId, connection.provider, {
        text: 'Trellis HRMS — test message from Integration Hub',
      })

      // Update connection status based on result
      await db.tenant(req.ctx.tenantId, async (q) => {
        if (result.ok) {
          await repo.updateConnection(q, id, {
            status: 'connected',
            lastVerifiedAt: new Date().toISOString(),
            lastError: null,
          })
        } else {
          await repo.updateConnection(q, id, {
            status: 'error',
            lastError: result.error ?? 'test failed',
          })
        }
      })

      return {
        ok: result.ok,
        provider: result.provider,
        connectionId: result.connectionId,
        durationMs: result.durationMs,
        status: result.ok ? 'connected' : 'error',
        lastVerifiedAt: result.ok ? new Date().toISOString() : null,
        lastError: result.error ?? null,
      }
    },
  )
}
