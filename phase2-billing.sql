-- ============================================================================
-- HRMS SaaS Platform — Phase 2 Migration 4: Billing & Metering
-- Applied idempotently by src/db/schema.ts (applyBillingSchema) on every boot,
-- mirroring the ATS/onboarding migrations. Both tables are tenant-scoped and
-- covered by the RLS hardening pass via TENANT_SCOPED_TABLES.
--
-- Model:
--  * subscriptions — one row per tenant describing the active commercial
--    arrangement. Phase 0/1 hardcodes a single `trial` plan; Phase 2 exposes
--    the subscription surface so the SaaS funnel can upgrade in place (still
--    no Stripe — plan changes are recorded here + audited).
--  * usage_events — append-only metering stream. Producers (employee hire/
--    termination, onboarding plans, later AI calls) append a row inside the
--    same transaction as the domain event so metering is never lost. Billing
--    aggregates these to bill/forecast per metric.
-- ============================================================================

CREATE TABLE IF NOT EXISTS subscriptions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id),
    plan              TEXT NOT NULL DEFAULT 'trial',   -- 'trial' | 'core' | 'grow' | 'enterprise'
    status            TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'suspended' | 'cancelled'
    trial_ends_at     TIMESTAMPTZ,                     -- set when plan = 'trial'
    current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    current_period_end   TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 month',
    seat_limit        INT NOT NULL DEFAULT 5,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id)
);

CREATE TABLE IF NOT EXISTS usage_events (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id),
    metric            TEXT NOT NULL,                   -- 'seats' | 'onboarding_plans' | 'ai_agent_calls' | 'storage_mb'
    quantity          INT NOT NULL DEFAULT 1,
    entity_type       TEXT,                            -- 'employee' | 'onboarding_plan' | ...
    entity_id         UUID,
    occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_metric
    ON usage_events (tenant_id, metric, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant
    ON subscriptions (tenant_id);