import { loadConfig, loadEnvFile } from '../src/config.js'
import { Db } from '../src/db/index.js'
import { DEV_CREDENTIALS, seedDatabase } from '../src/seed/seed.js'

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
await seedDatabase(db)
console.log('Seed complete. Demo sign-ins:')
for (const c of DEV_CREDENTIALS) console.log(`  ${c.role.padEnd(8)} ${c.signin}`)
await db.close()