-- Phase 4 — Benefits Administration Module
-- Tables: benefit_plans, enrollment_periods, benefit_enrollments,
--         benefit_dependents, enrollment_dependents, life_events

CREATE TABLE IF NOT EXISTS benefit_plans (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    name                TEXT NOT NULL,
    description         TEXT,
    plan_type           TEXT NOT NULL,
    carrier_name        TEXT,
    coverage_tiers      TEXT[] NOT NULL DEFAULT '{}',
    employer_contribution_pct NUMERIC(5,2),
    employee_cost      JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active          BOOLEAN NOT NULL DEFAULT true,
    created_by         UUID REFERENCES user_accounts(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_plan_type CHECK (plan_type IN ('medical', 'dental', 'vision', 'life_insurance', 'retirement', 'hsa', 'fsa', 'other'))
);

ALTER TABLE benefit_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE benefit_plans FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS enrollment_periods (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            TEXT NOT NULL,
    description     TEXT,
    period_type     TEXT NOT NULL DEFAULT 'open_enrollment',
    status          TEXT NOT NULL DEFAULT 'draft',
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL,
    coverage_starts DATE,
    created_by      UUID REFERENCES user_accounts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_period_type CHECK (period_type IN ('open_enrollment', 'life_event')),
    CONSTRAINT valid_enrollment_status CHECK (status IN ('draft', 'active', 'closed', 'finalized')),
    CONSTRAINT valid_enrollment_dates CHECK (starts_at < ends_at)
);

ALTER TABLE enrollment_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_periods FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS benefit_enrollments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    employee_id         UUID NOT NULL REFERENCES employees(id),
    enrollment_period_id UUID NOT NULL REFERENCES enrollment_periods(id),
    benefit_plan_id     UUID NOT NULL REFERENCES benefit_plans(id),
    coverage_tier       TEXT NOT NULL,
    employee_premium    NUMERIC(10,2) NOT NULL,
    employer_premium    NUMERIC(10,2) NOT NULL,
    status              TEXT NOT NULL DEFAULT 'draft',
    submitted_at        TIMESTAMPTZ,
    confirmed_at        TIMESTAMPTZ,
    withdrawn_at        TIMESTAMPTZ,
    notes               TEXT,
    created_by          UUID REFERENCES user_accounts(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_enrollment_status CHECK (status IN ('draft', 'submitted', 'confirmed', 'withdrawn')),
    CONSTRAINT valid_coverage_tier CHECK (coverage_tier IN ('employee_only', 'employee_spouse', 'employee_child', 'family')),
    CONSTRAINT unique_employee_plan_period UNIQUE (employee_id, enrollment_period_id, benefit_plan_id)
);

ALTER TABLE benefit_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE benefit_enrollments FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS benefit_dependents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    first_name      TEXT NOT NULL,
    last_name       TEXT NOT NULL,
    relationship    TEXT NOT NULL,
    date_of_birth   DATE,
    ssn_enc         TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_relationship CHECK (relationship IN ('spouse', 'child', 'domestic_partner'))
);

ALTER TABLE benefit_dependents ENABLE ROW LEVEL SECURITY;
ALTER TABLE benefit_dependents FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS enrollment_dependents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    enrollment_id       UUID NOT NULL REFERENCES benefit_enrollments(id) ON DELETE CASCADE,
    dependent_id        UUID NOT NULL REFERENCES benefit_dependents(id) ON DELETE CASCADE,

    CONSTRAINT unique_enrollment_dependent UNIQUE (enrollment_id, dependent_id)
);

ALTER TABLE enrollment_dependents ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_dependents FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS life_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    employee_id         UUID NOT NULL REFERENCES employees(id),
    event_type          TEXT NOT NULL,
    event_date          DATE NOT NULL,
    description         TEXT,
    status              TEXT NOT NULL DEFAULT 'reported',
    enrollment_period_id UUID REFERENCES enrollment_periods(id),
    reported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_by     UUID REFERENCES user_accounts(id),
    acknowledged_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_life_event_type CHECK (event_type IN ('marriage', 'birth', 'divorce', 'death', 'adoption', 'loss_of_other_coverage', 'gain_of_other_coverage')),
    CONSTRAINT valid_life_event_status CHECK (status IN ('reported', 'acknowledged', 'enrollment_window_opened'))
);

ALTER TABLE life_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE life_events FORCE ROW LEVEL SECURITY;
