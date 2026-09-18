import { loadConfig, loadEnvFile } from './config.js'
import { Db } from './db/index.js'
import { buildApp } from './http/app.js'

loadEnvFile()
const config = loadConfig()

if (!config.databaseUrl) {
  console.error('DATABASE_URL is required — see .env.example')
  process.exit(1)
}

const db = await Db.open({
  connectionString: config.databaseUrl,
  max: config.dbPoolSize,
  ssl: config.dbSsl,
})
const app = await buildApp({ db, config })

const shutdown = async () => {
  app.log.info('shutting down')
  await app.close()
  await db.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  await app.listen({ port: config.port, host: config.host })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}