/**
 * Shared test warm-up: pokes the database once before the real tests run.
 *
 * Neon free tier suspends compute after ~5 min of inactivity.  On wake the
 * pooler accepts TCP but the backend can take 30-90 s to come online.
 * A single throwaway probe with generous timeout + retry covers the cold-start
 * window so the actual test suite never pays the penalty per-test.
 *
 * If Neon is genuinely down or the URL is wrong, all retries fail and the
 * function throws — "slow" vs "broken" is never masked.
 */
import { Pool } from 'pg'

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 20_000
const CONNECT_TIMEOUT_MS = 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Call once in beforeAll, BEFORE `Db.open()`.  Logs each attempt to stdout
 * so cold vs warm sessions are visually obvious in CI output.
 */
export async function warmUpDb(databaseUrl: string): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    min: 0,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ssl: true,
  })

  const start = Date.now()
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now()
    try {
      const client = await pool.connect()
      try {
        await client.query('SELECT 1')
      } finally {
        client.release()
      }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      const total = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`  [warm-up] attempt ${attempt}: connected in ${elapsed}s (total ${total}s)`)
      await pool.end()
      return
    } catch (err: any) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      const code = err?.code ?? 'UNKNOWN'
      console.log(`  [warm-up] attempt ${attempt}: FAILED after ${elapsed}s (${code}: ${err?.message})`)
      if (attempt < MAX_ATTEMPTS) {
        console.log(`  [warm-up] retrying in ${RETRY_DELAY_MS / 1000}s...`)
        await sleep(RETRY_DELAY_MS)
      }
    }
  }

  // All attempts exhausted — this is a real failure, not a cold start.
  await pool.end()
  throw new Error(
    `[warm-up] Neon did not respond after ${MAX_ATTEMPTS} attempts (${CONNECT_TIMEOUT_MS / 1000}s timeout each, ${RETRY_DELAY_MS / 1000}s between). ` +
    'Check DATABASE_URL, Neon project status, and network. Aborting.',
  )
}
