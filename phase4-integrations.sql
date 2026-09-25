-- Phase 4 — Integration Hub Module
-- Tables: integration_connections

CREATE TABLE IF NOT EXISTS integration_connections (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id),
    provider         TEXT NOT NULL,
    label            TEXT NOT NULL,
    credential_enc   TEXT NOT NULL,
    masked_preview   TEXT NOT NULL,
    key_version      SMALLINT NOT NULL DEFAULT 1,
    status           TEXT NOT NULL DEFAULT 'disconnected'
                     CHECK (status IN ('connected', 'disconnected', 'error', 'verifying')),
    config_json      JSONB,
    last_verified_at TIMESTAMPTZ,
    last_error       TEXT,
    created_by       UUID REFERENCES user_accounts(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections FORCE ROW LEVEL SECURITY;
