import type { Q } from '../../db/index.js'
import { newId } from '../../db/index.js'

export interface PolicyDocument {
  id: string
  tenant_id: string
  title: string
  file_key: string
  chunk_count: number
  created_at: Date
  deleted_at: Date | null
}

export interface PolicyChunk {
  id: string
  tenant_id: string
  document_id: string
  chunk_index: number
  content: string
  created_at: Date
}

export interface PolicyChunkWithScore extends PolicyChunk {
  document_title: string
  similarity: number
}

/** Semantic search over policy document chunks, scoped to the current tenant. */
export async function searchChunks(
  q: Q,
  embedding: number[],
  limit = 5,
): Promise<PolicyChunkWithScore[]> {
  const vectorLiteral = `[${embedding.join(',')}]`
  const res = await q.query<PolicyChunkWithScore>(
    `SELECT c.id, c.document_id, c.chunk_index, c.content, c.created_at,
            d.title AS document_title,
            1 - (c.embedding <=> $1::vector) AS similarity
     FROM policy_document_chunks c
     JOIN policy_documents d ON d.id = c.document_id
     WHERE d.tenant_id = current_setting('app.current_tenant', true)::uuid
       AND d.deleted_at IS NULL
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    [vectorLiteral, limit],
  )
  return res.rows
}

/** Insert a document and its chunks in a single transaction. */
export async function insertDocumentWithChunks(
  q: Q,
  doc: { title: string; file_key: string },
  chunks: { content: string; embedding: number[] }[],
): Promise<PolicyDocument> {
  const docId = newId()
  await q.exec(
    `INSERT INTO policy_documents (id, tenant_id, title, file_key, chunk_count)
     VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4)`,
    [docId, doc.title, doc.file_key, chunks.length],
  )
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    const vectorLiteral = `[${chunk.embedding.join(',')}]`
    await q.exec(
      `INSERT INTO policy_document_chunks (id, tenant_id, document_id, chunk_index, content, embedding)
       VALUES ($1, current_setting('app.current_tenant', true)::uuid, $2, $3, $4, $5::vector)`,
      [newId(), docId, i, chunk.content, vectorLiteral],
    )
  }
  return {
    id: docId,
    tenant_id: '', // set by RLS
    title: doc.title,
    file_key: doc.file_key,
    chunk_count: chunks.length,
    created_at: new Date(),
    deleted_at: null,
  }
}
