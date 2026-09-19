import Fastify, { type FastifyInstance } from 'fastify'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadConfig, loadEnvFile } from '../src/config.js'
import { Db } from '../src/db/index.js'
import { buildApp } from '../src/http/app.js'

loadEnvFile()
const config = loadConfig()

let cached: {
  app: FastifyInstance
  db: Db
} | null = null

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required to boot the Fastify lambda')
  }
  if (!cached) {
    const db = await Db.open({
      connectionString: config.databaseUrl,
      max: config.dbPoolSize,
      ssl: config.dbSsl,
    })
    const app: FastifyInstance = await buildApp({
      db,
      config,
      logger: false,
    })
    await app.ready()
    cached = { app, db }
  }
  cached.app.server.emit('request', req, res)
}
