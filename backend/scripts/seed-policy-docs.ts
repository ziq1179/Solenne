/**
 * Seed policy documents for Phase 3 verification.
 *
 * Usage: pnpm tsx scripts/seed-policy-docs.ts
 *
 * Requires OPENAI_API_KEY to generate real embeddings.
 * Falls back to a deterministic pseudo-embedding for local testing.
 */

import { loadConfig, loadEnvFile } from '../src/config.js'
import { Db } from '../src/db/index.js'
import { embed } from '../src/modules/ai/embeddings.js'
import * as repo from '../src/modules/ai/ai.repo.js'

loadEnvFile()
const config = loadConfig()
if (!config.databaseUrl) {
  console.error('DATABASE_URL is required — see .env.example')
  process.exit(1)
}

// Deterministic pseudo-embedding for local testing (no OpenAI key required).
function pseudoEmbed(text: string): number[] {
  const vec = new Array(1536).fill(0)
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i)
    vec[i % 1536] += charCode / 1000
    vec[(i * 7 + 13) % 1536] += charCode / 2000
  }
  // Normalize to unit vector.
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  return norm > 0 ? vec.map((v) => v / norm) : vec
}

const SAMPLE_CHUNKS = [
  {
    content:
      'Annual leave: Full-time employees are entitled to 20 days of paid annual leave per calendar year. Leave must be requested at least 2 weeks in advance. Unused days may carry over up to 5 days into the next year.',
    embedding: null as number[] | null,
  },
  {
    content:
      'Sick leave: Employees are entitled to 10 days of paid sick leave per year. A medical certificate is required for absences exceeding 3 consecutive days. Sick leave does not carry over.',
    embedding: null as number[] | null,
  },
  {
    content:
      'Remote work policy: Employees may work remotely up to 3 days per week with manager approval. Full remote arrangements require HR approval and a signed remote work agreement.',
    embedding: null as number[] | null,
  },
  {
    content:
      'Bereavement leave: Employees are entitled to 5 days of paid leave following the death of an immediate family member (spouse, child, parent, sibling) or 3 days for extended family.',
    embedding: null as number[] | null,
  },
  {
    content:
      'Parental leave: Primary caregivers are entitled to 16 weeks of paid parental leave. Secondary caregivers are entitled to 4 weeks. Leave must be taken within 12 months of the child\'s birth or placement.',
    embedding: null as number[] | null,
  },
]

async function main() {
  const db = await Db.open({
    connectionString: config.databaseUrl!,
    max: config.dbPoolSize,
    ssl: config.dbSsl,
  })

  // Find the demo tenant.
  const tenants = await db.system(async (q) => {
    const res = await q.query<{ id: string }>(
      `SELECT id FROM tenants WHERE subdomain = 'demo' LIMIT 1`,
    )
    return res.rows
  })

  if (tenants.length === 0) {
    console.error('No demo tenant found. Run the main seed script first.')
    await db.close()
    process.exit(1)
  }

  const tenantId = tenants[0]!.id
  console.log(`Seeding policy documents for tenant: ${tenantId}`)

  // Generate embeddings (use real OpenAI if key is available, otherwise pseudo).
  const hasOpenAi = !!process.env.OPENAI_API_KEY
  console.log(`Embedding provider: ${hasOpenAi ? 'OpenAI (text-embedding-3-small)' : 'pseudo-embedding (local testing)'}`)

  for (const chunk of SAMPLE_CHUNKS) {
    chunk.embedding = hasOpenAi ? await embed(chunk.content) : pseudoEmbed(chunk.content)
  }

  // Insert the document and chunks.
  await db.tenant(tenantId, async (q) => {
    const doc = await repo.insertDocumentWithChunks(
      q,
      { title: 'Employee Handbook — Leave & Work Policies', file_key: 'seed/employee-handbook.pdf' },
      SAMPLE_CHUNKS.map((c) => ({ content: c.content, embedding: c.embedding! })),
    )
    console.log(`Inserted document: ${doc.id} (${doc.chunk_count} chunks)`)
  })

  console.log('Policy document seed complete.')
  await db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
