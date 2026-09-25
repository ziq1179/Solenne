import OpenAI from 'openai'

const EMBEDDING_MODEL = 'text-embedding-3-small' as const
const EMBEDDING_DIMENSIONS = 1536

let _client: OpenAI | null = null

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for embeddings')
    _client = new OpenAI({ apiKey })
  }
  return _client
}

/** Generate an embedding vector for a single text string. */
export async function embed(text: string): Promise<number[]> {
  const client = getClient()
  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  })
  return res.data[0]?.embedding ?? []
}

/** Generate embedding vectors for multiple texts in one API call. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const client = getClient()
  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  })
  // OpenAI returns embeddings in input order.
  return res.data.map((e) => e.embedding)
}

export const EMBEDDING_DIM = EMBEDDING_DIMENSIONS
