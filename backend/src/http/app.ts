import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import type { Db } from '../db/index.js'
import type { Config } from '../config.js'
import { registerErrorHandler } from './errors.js'
import { registerAuthRoutes } from '../modules/auth/auth.routes.js'
import { registerEmployeeRoutes } from '../modules/employees/employees.routes.js'
import { registerLeaveRoutes } from '../modules/leave/leave.routes.js'

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
  await fastify.register(jwt, { secret: opts.config.jwtSecret })

  registerErrorHandler(fastify)

  fastify.get('/', async () => ({
    name: 'Solenne',
    description: 'Trellis HR API',
    status: 'ok',
    version: '1.0.0',
  }))
  fastify.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }))

  registerAuthRoutes(fastify)
  registerEmployeeRoutes(fastify)
  registerLeaveRoutes(fastify)

  return fastify
}