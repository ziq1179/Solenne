-- Phase 3 — AI Agent Layer
-- Policy document storage + pgvector embeddings for RAG search.

CREATE TABLE IF NOT EXISTS policy_documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    title           TEXT NOT NULL,
    file_key        TEXT NOT NULL,
    chunk_count     INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

ALTER TABLE policy_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_documents FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS policy_document_chunks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    document_id     UUID NOT NULL REFERENCES policy_documents(id),
    chunk_index     INT NOT NULL,
    content         TEXT NOT NULL,
    embedding       vector(1536),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE policy_document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_document_chunks FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON policy_document_chunks
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
