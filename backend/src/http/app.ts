import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import cookie from '@fastify/cookie'
import type { Db } from '../db/index.js'
import type { Config } from '../config.js'
import { registerErrorHandler } from './errors.js'
import { registerAuthRoutes } from '../modules/auth/auth.routes.js'
import { registerTenantRoutes } from '../modules/tenants/tenants.routes.js'
import { registerAtsRoutes } from '../modules/ats/ats.routes.js'
import { registerOnboardingRoutes } from '../modules/onboarding/onboarding.routes.js'
import { registerNotificationsRoutes } from '../modules/notifications/notifications.routes.js'
import { registerBillingRoutes } from '../modules/billing/billing.routes.js'
import { registerEmployeeRoutes } from '../modules/employees/employees.routes.js'
import { registerLeaveRoutes } from '../modules/leave/leave.routes.js'
import { registerAttendanceRoutes } from '../modules/attendance/attendance.routes.js'
import { registerReportRoutes } from '../modules/reports/reports.routes.js'
import { registerAiRoutes } from '../modules/ai/ai.routes.js'
import { registerPayrollRoutes } from '../modules/payroll/payroll.routes.js'
import { registerPerformanceRoutes } from '../modules/performance/performance.routes.js'
import { registerBenefitsRoutes } from '../modules/benefits/benefits.routes.js'
import { registerIntegrationsRoutes } from '../modules/integrations/integrations.routes.js'
import { registerSsoRoutes } from '../modules/sso/sso.routes.js'
import { registerMigrationRoutes } from '../modules/migrations/migrations.routes.js'
import { registerQuiescenceGate } from '../modules/migrations/quiescence.js'

function landingPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Solenne — Trellis HR API</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        background: linear-gradient(160deg, #0f172a, #1e293b);
        color: #e2e8f0;
      }
      main { text-align: center; padding: 2rem; max-width: 560px; }
      h1 { font-size: 2.5rem; margin: 0 0 .5rem; letter-spacing: -.02em; }
      h1 span { color: #38bdf8; }
      p.lead { color: #94a3b8; margin: 0 0 2rem; font-size: 1.05rem; }
      .status {
        display: inline-block; padding: .4rem .9rem; border-radius: 999px;
        background: rgba(34,197,94,.15); color: #4ade80;
        border: 1px solid rgba(34,197,94,.35); font-size: .85rem; font-weight: 600;
        margin-bottom: 2rem;
      }
      ul { list-style: none; padding: 0; margin: 0 0 2rem; font-size: .95rem; }
      li { margin: .5rem 0; }
      a {
        color: #38bdf8; text-decoration: none; border-bottom: 1px solid transparent;
      }
      a:hover { border-bottom-color: #38bdf8; }
      code {
        background: rgba(148,163,184,.15); padding: .1rem .4rem;
        border-radius: 4px; font-size: .85em;
      }
      footer { color: #64748b; font-size: .8rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Solenne <span>—</span> Trellis HR API</h1>
      <p class="lead">The backend for the Trellis HRMS SaaS platform. Tenancy, auth/IAM, core HR, leave, attendance, reporting and audit — with per-tenant Row-Level-Security.</p>
      <div class="status">● API online</div>
      <ul>
        <li><a href="/health">/health</a> — <code>liveness probe</code></li>
        <li><a href="/auth/login">POST /auth/login</a> — <code>get a JWT</code></li>
        <li><a href="/auth/refresh">POST /auth/refresh</a> — <code>rotate tokens</code></li>
        <li><a href="/auth/me">GET /auth/me</a> — <code>current user (Bearer token)</code></li>
      </ul>
      <footer>Solenne v1.0.0 — Fastify &middot; PostgreSQL &middot; Neon</footer>
    </main>
  </body>
</html>`
}

export interface BuildAppOptions {
  db: Db
  config: Config
  logger?: boolean
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: opts.logger ?? true })

  fastify.decorate('db', opts.db)
  fastify.decorate('config', opts.config)

  await fastify.register(cors, { origin: true })
  await fastify.register(cookie)
  await fastify.register(jwt, { secret: opts.config.jwtSecret })

  registerErrorHandler(fastify)
  // The quiescence gate must be registered before the auth routes so the
  // onRequest hook (JWT-based write pause for mid-migration tenants) runs
  // ahead of authenticate.
  registerQuiescenceGate(fastify)

  fastify.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(landingPage()),
  )
  fastify.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }))

  registerAuthRoutes(fastify)
  registerTenantRoutes(fastify)
  registerAtsRoutes(fastify)
  registerOnboardingRoutes(fastify)
  registerNotificationsRoutes(fastify)
  registerBillingRoutes(fastify)
  registerEmployeeRoutes(fastify)
  registerLeaveRoutes(fastify)
  registerAttendanceRoutes(fastify)
  registerReportRoutes(fastify)
  registerAiRoutes(fastify)
  registerPayrollRoutes(fastify)
  registerPerformanceRoutes(fastify)
  registerBenefitsRoutes(fastify)
  registerIntegrationsRoutes(fastify)
  registerSsoRoutes(fastify)
  registerMigrationRoutes(fastify)

  return fastify
}