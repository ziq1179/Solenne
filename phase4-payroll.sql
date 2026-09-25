-- Phase 4 — Payroll Module
-- Payroll runs and payslips. Reads from compensation_records (Phase 0/1).
-- Immutable once generated: corrections create new versioned rows.

CREATE TABLE IF NOT EXISTS payroll_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft',
    total_gross     NUMERIC(14,2),
    total_net       NUMERIC(14,2),
    total_deductions NUMERIC(14,2),
    employee_count  INT,
    currency        TEXT NOT NULL DEFAULT 'USD',
    notes           TEXT,
    correction_of   UUID REFERENCES payroll_runs(id),
    approved_by     UUID REFERENCES user_accounts(id),
    approved_at     TIMESTAMPTZ,
    paid_at         TIMESTAMPTZ,
    created_by      UUID REFERENCES user_accounts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_status CHECK (status IN ('draft', 'calculated', 'approved', 'paid')),
    CONSTRAINT unique_period UNIQUE (tenant_id, period_start, period_end)
);

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS payslips (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    payroll_run_id  UUID NOT NULL REFERENCES payroll_runs(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    compensation_record_id UUID NOT NULL REFERENCES compensation_records(id),

    base_pay        NUMERIC(14,2) NOT NULL,
    overtime_pay    NUMERIC(14,2) NOT NULL DEFAULT 0,
    bonus           NUMERIC(14,2) NOT NULL DEFAULT 0,
    other_earnings  NUMERIC(14,2) NOT NULL DEFAULT 0,
    gross_pay       NUMERIC(14,2) NOT NULL,

    deductions      JSONB NOT NULL DEFAULT '[]'::jsonb,
    total_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,

    net_pay         NUMERIC(14,2) NOT NULL,

    currency        TEXT NOT NULL DEFAULT 'USD',
    tax_compliant   BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_net CHECK (net_pay = gross_pay - total_deductions)
);

ALTER TABLE payslips ENABLE ROW LEVEL SECURITY;
ALTER TABLE payslips FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_payroll_runs_tenant ON payroll_runs (tenant_id, period_start);
CREATE INDEX IF NOT EXISTS idx_payslips_run ON payslips (tenant_id, payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payslips_employee ON payslips (tenant_id, employee_id);
