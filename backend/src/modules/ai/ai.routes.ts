import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { PERMISSIONS } from '../permissions.js'
import { embed } from './embeddings.js'
import * as repo from './ai.repo.js'
import { processMessage, type AgentMessage } from './agent.js'

const searchSchema = z.object({
  query: z.string().min(1, 'query is required').max(1000),
})

const chatSchema = z.object({
  message: z.string().min(1, 'message is required').max(4000),
  conversationId: z.string().uuid().optional(),
})

// In-memory conversation store (per-server instance). In production, persist to DB.
const conversations = new Map<string, AgentMessage[]>()

export function registerAiRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  // ── POST /ai/search-policy ────────────────────────────────────────────────
  // Semantic search over the tenant's policy documents.
  fastify.post(
    '/ai/search-policy',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.LEAVE_READ)] },
    async (req) => {
      const parsed = searchSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      const embedding = await embed(parsed.data.query)
      const results = await db.tenant(req.ctx.tenantId, (q) => repo.searchChunks(q, embedding))
      return { results }
    },
  )

  // ── POST /ai/chat ─────────────────────────────────────────────────────────
  // Agent chat endpoint. Processes a user message, dispatches tools, returns reply.
  fastify.post(
    '/ai/chat',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.LEAVE_READ)] },
    async (req) => {
      const parsed = chatSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid request', parsed.error.flatten())

      const conversationId = parsed.data.conversationId ?? crypto.randomUUID()
      const history = conversations.get(conversationId) ?? []

      const apiBase = process.env.BACKEND_URL ?? 'http://localhost:4000'

      const result = await db.tenant(req.ctx.tenantId, (q) =>
        processMessage(
          parsed.data.message,
          history,
          {
            accessToken: (req.headers.authorization ?? '').replace('Bearer ', ''),
            apiBase,
            employeeId: req.ctx.employeeId,
            isDirectoryRole: req.ctx.isDirectoryRole,
            tenantId: req.ctx.tenantId,
          },
          q,
          req.ctx.tenantId,
        ),
      )

      // Store updated conversation (append user + assistant messages).
      const updatedHistory = [
        ...history,
        { role: 'user' as const, content: parsed.data.message },
        { role: 'assistant' as const, content: result.reply },
      ]
      conversations.set(conversationId, updatedHistory)

      // Cap conversations at 50 messages to prevent memory bloat.
      if (updatedHistory.length > 50) {
        conversations.set(conversationId, updatedHistory.slice(-50))
      }

      return {
        reply: result.reply,
        conversationId,
        toolCalls: result.toolCalls,
      }
    },
  )
}
