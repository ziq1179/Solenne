import { loadConfig, loadEnvFile } from '../src/config.js'
import { Db } from '../src/db/index.js'

loadEnvFile()
const config = loadConfig()
if (!config.databaseUrl) {
  console.error('DATABASE_URL is required — see .env.example')
  process.exit(1)
}

// Db.open connects, applies the canonical schema + RLS hardening when absent,
// and fails fast on unreachable databases.
const db = await Db.open({
  connectionString: config.databaseUrl,
  max: config.dbPoolSize,
  ssl: config.dbSsl,
})
const info = (
  await db.unsafe().query<{ db: string; v: string }>(`SELECT current_database() AS db, version() AS v`)
).rows[0]
console.log(`Trellis HRMS API — Postgres ready`)
console.log(`  ${info?.db ?? '?'} · PostgreSQL ${info?.v.match(/PostgreSQL (\d+(\.\d+)*)/)?.[1] ?? '?'}`)
await db.close()