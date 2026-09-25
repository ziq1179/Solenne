-- Phase 4 — Performance Management Module
-- Goals, review cycles, performance reviews, continuous feedback.
-- Reads from employees (Phase 0/1) for org hierarchy via manager_employee_id.

CREATE TABLE IF NOT EXISTS goals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    title           TEXT NOT NULL,
    description     TEXT,
    category        TEXT,
    goal_type       TEXT NOT NULL DEFAULT 'okr',
    target_value    NUMERIC(10,2),
    current_value   NUMERIC(10,2) DEFAULT 0,
    percentage      INT DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'active',
    due_date        DATE,
    completed_at    TIMESTAMPTZ,
    created_by      UUID REFERENCES user_accounts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_goal_type CHECK (goal_type IN ('okr', 'kpi', 'custom')),
    CONSTRAINT valid_goal_status CHECK (status IN ('active', 'completed', 'abandoned')),
    CONSTRAINT valid_percentage CHECK (percentage >= 0 AND percentage <= 100)
);

ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS review_cycles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'draft',
    starts_at       DATE NOT NULL,
    ends_at         DATE NOT NULL,
    review_deadline DATE,
    finalized_by    UUID REFERENCES user_accounts(id),
    finalized_at    TIMESTAMPTZ,
    created_by      UUID REFERENCES user_accounts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_cycle_status CHECK (status IN ('draft', 'active', 'collecting', 'calibration', 'finalized')),
    CONSTRAINT valid_cycle_dates CHECK (starts_at < ends_at),
    CONSTRAINT unique_cycle_name UNIQUE (tenant_id, name)
);

ALTER TABLE review_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_cycles FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS cycle_goals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    cycle_id        UUID NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
    goal_id         UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    mapped_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_cycle_goal UNIQUE (cycle_id, goal_id)
);

ALTER TABLE cycle_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cycle_goals FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS performance_reviews (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    cycle_id        UUID NOT NULL REFERENCES review_cycles(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),

    self_rating     INT,
    self_comment    TEXT,
    self_submitted_at TIMESTAMPTZ,

    manager_id      UUID REFERENCES employees(id),
    manager_rating  INT,
    manager_comment TEXT,
    manager_submitted_at TIMESTAMPTZ,

    final_rating    INT,
    finalized_by    UUID REFERENCES user_accounts(id),
    finalized_at    TIMESTAMPTZ,

    status          TEXT NOT NULL DEFAULT 'draft',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_review_status CHECK (status IN ('draft', 'self_submitted', 'manager_reviewing', 'calibration', 'finalized')),
    CONSTRAINT valid_final_rating CHECK (final_rating IS NULL OR (final_rating >= 1 AND final_rating <= 5)),
    CONSTRAINT unique_employee_cycle UNIQUE (cycle_id, employee_id)
);

ALTER TABLE performance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_reviews FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS feedback_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    author_id       UUID NOT NULL REFERENCES employees(id),
    recipient_id    UUID NOT NULL REFERENCES employees(id),
    cycle_id        UUID REFERENCES review_cycles(id),
    content         TEXT NOT NULL,
    feedback_type   TEXT NOT NULL DEFAULT 'general',
    is_anonymous    BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_feedback_type CHECK (feedback_type IN ('general', 'kudos', 'coaching', 'peer'))
);

ALTER TABLE feedback_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_entries FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_goals_tenant_employee ON goals (tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_review_cycles_tenant ON review_cycles (tenant_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_cycle_goals_cycle ON cycle_goals (tenant_id, cycle_id);
CREATE INDEX IF NOT EXISTS idx_performance_reviews_cycle ON performance_reviews (tenant_id, cycle_id);
CREATE INDEX IF NOT EXISTS idx_performance_reviews_employee ON performance_reviews (tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_feedback_entries_recipient ON feedback_entries (tenant_id, recipient_id);
CREATE INDEX IF NOT EXISTS idx_feedback_entries_author ON feedback_entries (tenant_id, author_id);
