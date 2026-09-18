-- ============================================================================
-- HRMS SaaS Platform — Phase 0/1 Database Schema
-- Target: PostgreSQL 18 on Neon (upstream only needs >= 13; see backend's
-- transform for the uuid_generate_v4() -> gen_random_uuid() swap). Applied at
-- bootstrap by scripts/init-db.ts, hardened by src/db/schema.ts (hardenRls).
-- Every tenant-scoped table has tenant_id + RLS policy enabled.
-- Scope: Tenancy, Auth/IAM, Core HR, Leave, Attendance, Audit Log.
-- Out of scope (later phases): Payroll, Benefits, ATS, Performance, LMS,
-- Billing/metering — these get their own migration files when built.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. TENANCY
-- ----------------------------------------------------------------------------

CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    subdomain       TEXT NOT NULL UNIQUE,
    custom_domain   TEXT UNIQUE,
    plan            TEXT NOT NULL DEFAULT 'trial',      -- 'trial' | 'core' | 'grow' | 'enterprise'
    status          TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'suspended' | 'cancelled'
    region          TEXT NOT NULL DEFAULT 'us-east-1',  -- data residency placeholder for future phases
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

-- ----------------------------------------------------------------------------
-- 2. AUTH / IAM
-- ----------------------------------------------------------------------------

CREATE TABLE user_accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    email           TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'invited' | 'disabled'
    mfa_enabled     BOOLEAN NOT NULL DEFAULT false,
    mfa_secret_enc  TEXT,                                -- envelope-encrypted at app layer
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    UNIQUE (tenant_id, email)
);

CREATE TABLE roles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            TEXT NOT NULL,                       -- 'admin' | 'hr_manager' | 'manager' | 'employee' (+ custom)
    is_system_role  BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE permissions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            TEXT NOT NULL UNIQUE,                -- e.g. 'employee:read', 'leave:approve'
    description     TEXT
);

CREATE TABLE role_permissions (
    role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id   UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
    user_id         UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
    role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    user_id         UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 3. CORE HR / ORGANIZATION
-- ----------------------------------------------------------------------------

CREATE TABLE departments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            TEXT NOT NULL,
    parent_id       UUID REFERENCES departments(id),
    cost_center     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);

CREATE TABLE locations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            TEXT NOT NULL,
    country         TEXT NOT NULL,                       -- ISO 3166-1 alpha-2
    timezone        TEXT NOT NULL DEFAULT 'UTC',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employees (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    user_account_id     UUID REFERENCES user_accounts(id),   -- nullable until ESS account is provisioned
    employee_number     TEXT NOT NULL,
    first_name          TEXT NOT NULL,
    last_name           TEXT NOT NULL,
    personal_email      TEXT,
    work_email          TEXT,
    phone               TEXT,
    date_of_birth_enc   TEXT,                                -- column-level encrypted PII
    national_id_enc     TEXT,                                -- column-level encrypted PII
    department_id       UUID REFERENCES departments(id),
    location_id         UUID REFERENCES locations(id),
    manager_employee_id UUID REFERENCES employees(id),
    job_title           TEXT,
    employment_type     TEXT NOT NULL DEFAULT 'full_time',   -- 'full_time' | 'part_time' | 'contractor'
    employment_status   TEXT NOT NULL DEFAULT 'active',       -- 'active' | 'on_leave' | 'terminated'
    hire_date           DATE NOT NULL,
    termination_date    DATE,
    custom_fields       JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          UUID REFERENCES user_accounts(id),
    updated_by          UUID REFERENCES user_accounts(id),
    deleted_at          TIMESTAMPTZ,
    UNIQUE (tenant_id, employee_number)
);

-- Effective-dated employment history (job title / department / manager changes over time)
CREATE TABLE employment_history (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    effective_date  DATE NOT NULL,
    job_title       TEXT,
    department_id   UUID REFERENCES departments(id),
    manager_employee_id UUID REFERENCES employees(id),
    employment_status TEXT NOT NULL,
    change_reason   TEXT,                                 -- 'promotion' | 'transfer' | 'hire' | 'termination' | ...
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      UUID REFERENCES user_accounts(id)
);

-- Effective-dated compensation history (never overwritten)
CREATE TABLE compensation_records (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    effective_date  DATE NOT NULL,
    base_salary_amount NUMERIC(14,2) NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'USD',
    pay_frequency   TEXT NOT NULL DEFAULT 'monthly',       -- 'monthly' | 'biweekly' | 'weekly'
    change_reason   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      UUID REFERENCES user_accounts(id)
);

-- ----------------------------------------------------------------------------
-- 4. LEAVE MANAGEMENT
-- ----------------------------------------------------------------------------

CREATE TABLE leave_types (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    name                TEXT NOT NULL,                     -- 'Annual Leave', 'Sick Leave', ...
    accrual_days_per_year NUMERIC(6,2) NOT NULL DEFAULT 0,
    carry_forward_max_days NUMERIC(6,2) NOT NULL DEFAULT 0,
    requires_approval   BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE leave_balances (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    leave_type_id   UUID NOT NULL REFERENCES leave_types(id),
    year            INT NOT NULL,
    accrued_days    NUMERIC(6,2) NOT NULL DEFAULT 0,
    used_days       NUMERIC(6,2) NOT NULL DEFAULT 0,
    carried_over_days NUMERIC(6,2) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, employee_id, leave_type_id, year)
);

CREATE TABLE leave_requests (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    leave_type_id   UUID NOT NULL REFERENCES leave_types(id),
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL,
    days_requested  NUMERIC(6,2) NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'approved' | 'rejected' | 'cancelled'
    reason          TEXT,
    approver_employee_id UUID REFERENCES employees(id),
    decided_at      TIMESTAMPTZ,
    decision_note   TEXT,
    submitted_via   TEXT NOT NULL DEFAULT 'web',            -- 'web' | 'mobile' | 'ai_agent'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 5. TIME & ATTENDANCE
-- ----------------------------------------------------------------------------

CREATE TABLE attendance_records (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    clock_in_at     TIMESTAMPTZ NOT NULL,
    clock_out_at    TIMESTAMPTZ,
    clock_in_source TEXT NOT NULL DEFAULT 'web',            -- 'web' | 'mobile' | 'biometric'
    clock_in_geo    POINT,
    clock_out_geo   POINT,
    total_minutes   INT,                                    -- computed on clock-out
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 6. AUDIT LOG (append-only, cross-module)
-- ----------------------------------------------------------------------------

CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    actor_type      TEXT NOT NULL,                          -- 'user' | 'ai_agent' | 'system'
    actor_id        UUID,                                    -- user_accounts.id or agent session id
    action          TEXT NOT NULL,                           -- 'employee.updated', 'leave.approved', ...
    entity_type     TEXT NOT NULL,
    entity_id       UUID NOT NULL,
    before_state    JSONB,
    after_state     JSONB,
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- No UPDATE or DELETE grants on audit_logs at the DB role level — insert-only.

-- ----------------------------------------------------------------------------
-- 7. ROW-LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- Applied identically to every tenant-scoped table. The application sets
--   SET app.current_tenant = '<tenant_uuid>';
-- on every pooled connection checkout, derived from the authenticated
-- request's JWT — never from a client-supplied tenant_id.

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT unnest(ARRAY[
            'user_accounts','roles','user_roles','refresh_tokens',
            'departments','locations','employees','employment_history',
            'compensation_records','leave_types','leave_balances',
            'leave_requests','attendance_records','audit_logs'
        ])
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                USING (tenant_id = current_setting(''app.current_tenant'', true)::uuid);', t
        );
    END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 8. INDEXES (baseline — extend per query pattern as they emerge)
-- ----------------------------------------------------------------------------

CREATE INDEX idx_employees_tenant_status ON employees (tenant_id, employment_status);
CREATE INDEX idx_employees_manager ON employees (manager_employee_id);
CREATE INDEX idx_leave_requests_tenant_employee ON leave_requests (tenant_id, employee_id);
CREATE INDEX idx_leave_requests_status ON leave_requests (tenant_id, status);
CREATE INDEX idx_attendance_employee_date ON attendance_records (tenant_id, employee_id, clock_in_at);
CREATE INDEX idx_audit_logs_entity ON audit_logs (tenant_id, entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (tenant_id, created_at);

-- ----------------------------------------------------------------------------
-- 9. SEED DATA — default roles & permissions (run once per new tenant)
-- ----------------------------------------------------------------------------
-- Recommended: wrap this in the tenant-provisioning service function rather
-- than a static seed, so it runs automatically on every self-service signup.
--
-- INSERT INTO permissions (code, description) VALUES
--   ('employee:read', 'View employee records'),
--   ('employee:write', 'Create/update employee records'),
--   ('leave:read', 'View leave requests/balances'),
--   ('leave:approve', 'Approve/reject leave requests'),
--   ('attendance:read', 'View attendance records'),
--   ('audit:read', 'View audit log')
-- ON CONFLICT (code) DO NOTHING;
