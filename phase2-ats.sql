-- ============================================================================
-- HRMS SaaS Platform — Phase 2 Migration 1: Recruitment / ATS (jobs + pipeline)
-- Applied idempotently by src/db/schema.ts (applyAtsSchema) on every boot, so
-- existing environments pick it up without a one-shot migration runner.
-- Every tenant-scoped table has tenant_id + RLS policy enabled (see hardenRls).
-- Out of scope here: interview scheduling/scorecards, offers, resume parsing
-- (AI later) — those get their own migration files when built.
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_openings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    title           TEXT NOT NULL,
    department_id   UUID REFERENCES departments(id),
    location_id     UUID REFERENCES locations(id),
    employment_type TEXT NOT NULL DEFAULT 'full_time',      -- 'full_time' | 'part_time' | 'contractor'
    salary_min      NUMERIC(14,2),
    salary_max      NUMERIC(14,2),
    currency        TEXT NOT NULL DEFAULT 'USD',
    description     TEXT,                                   -- posting body
    requirements    TEXT,
    headcount       INT NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'draft',          -- 'draft' | 'pending_approval' | 'open' | 'on_hold' | 'closed'
    created_by      UUID REFERENCES user_accounts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS job_candidates (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id),
    job_opening_id    UUID NOT NULL REFERENCES job_openings(id),
    first_name        TEXT NOT NULL,
    last_name         TEXT NOT NULL,
    email             TEXT NOT NULL,
    phone             TEXT,
    resume_text       TEXT,                                  -- structured/freeform resume (AI parsing lands here later)
    source            TEXT NOT NULL DEFAULT 'other',         -- 'referral' | 'job_board' | 'linkedin' | 'careers_page' | 'agency' | 'other'
    stage             TEXT NOT NULL DEFAULT 'sourced',       -- 'sourced' | 'applied' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected'
    rating            INT,                                   -- 1..5 scorecard placeholder
    notes             TEXT,
    hired_employee_id UUID REFERENCES employees(id),
    created_by        UUID REFERENCES user_accounts(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_job_openings_tenant_status
    ON job_openings (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_job_candidates_tenant_job_stage
    ON job_candidates (tenant_id, job_opening_id, stage);