-- ============================================================================
-- HRMS SaaS Platform — Phase 2 Migration 2: Onboarding / Offboarding
-- Applied idempotently by src/db/schema.ts (applyOnboardingSchema) on every
-- boot, mirroring the ATS migration. Every tenant-scoped table has tenant_id
-- and is covered by the RLS hardening pass via TENANT_SCOPED_TABLES.
--
-- Model: templated checklists. A template (kind onboarding|offboarding) holds
-- ordered tasks; starting a plan snapshots the active template's tasks into
-- the plan so later template edits never mutate a live plan. Plans are created
-- manually (source 'manual') or automatically (source 'system') when the ATS
-- moves a candidate to 'hired' — the "candidate → employee" domain event.
--
-- Out of scope here: IAM access-revocation publishing, payroll settlement
-- hand-off — those belong to their own modules (the audit log records the
-- trigger as an event for later consumers).
-- ============================================================================

CREATE TABLE IF NOT EXISTS onboarding_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'onboarding',   -- 'onboarding' | 'offboarding'
    description     TEXT,
    is_default      BOOLEAN NOT NULL DEFAULT false,       -- auto-start candidate hires from this (per kind)
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES user_accounts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS onboarding_template_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    template_id     UUID NOT NULL REFERENCES onboarding_templates(id),
    name            TEXT NOT NULL,
    category        TEXT NOT NULL DEFAULT 'general',  -- 'it_provisioning' | 'paperwork' | 'training' | 'access' | 'asset' | 'exit_interview' | 'settlement' | 'general'
    position        INT NOT NULL DEFAULT 0,
    optional        BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS onboarding_plans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    kind            TEXT NOT NULL,                       -- 'onboarding' | 'offboarding'
    template_id     UUID NOT NULL REFERENCES onboarding_templates(id),
    status          TEXT NOT NULL DEFAULT 'in_progress', -- 'in_progress' | 'completed' | 'cancelled'
    source          TEXT NOT NULL DEFAULT 'manual',      -- 'manual' | 'system'
    created_by      UUID REFERENCES user_accounts(id),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plan tasks are SNAPSHOTS of the template at plan start.
CREATE TABLE IF NOT EXISTS onboarding_tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    plan_id         UUID NOT NULL REFERENCES onboarding_plans(id),
    name            TEXT NOT NULL,
    category        TEXT NOT NULL DEFAULT 'general',
    position        INT NOT NULL DEFAULT 0,
    optional        BOOLEAN NOT NULL DEFAULT false,
    status          TEXT NOT NULL DEFAULT 'pending',     -- 'pending' | 'in_progress' | 'completed' | 'skipped'
    notes           TEXT,
    completed_by    UUID REFERENCES user_accounts(id),
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_templates_tenant_kind
    ON onboarding_templates (tenant_id, kind);
CREATE INDEX IF NOT EXISTS idx_onboarding_plans_tenant_employee
    ON onboarding_plans (tenant_id, employee_id, status);
CREATE INDEX IF NOT EXISTS idx_onboarding_tasks_plan
    ON onboarding_tasks (tenant_id, plan_id);

-- Idempotent migration: earlier versions of this DDL shipped onboarding_tasks
-- without created_at; converge existing databases without dropping the table.
ALTER TABLE onboarding_tasks
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();