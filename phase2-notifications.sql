-- ============================================================================
-- HRMS SaaS Platform — Phase 2 Migration 3: In-App Notifications
-- Applied idempotently by src/db/schema.ts (applyNotificationsSchema) on every
-- boot, mirroring the ATS/onboarding migrations. The table is tenant-scoped
-- and covered by the RLS hardening pass via TENANT_SCOPED_TABLES.
--
-- Model: app notifications addressed to a specific user account (NOT the
-- whole tenant). Producers call notifications.notify(...) inside the SAME
-- transaction as the domain event they announce (leave requested/decided,
-- candidate hired, onboarding plan started/completed). Consumers read only
-- rows where recipient_user_id = their own account — self-scoped by design,
-- so cross-user leakage is impossible even within a tenant.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id),
    recipient_user_id UUID NOT NULL REFERENCES user_accounts(id),
    type              TEXT NOT NULL,             -- 'leave.requested' | 'leave.approved' | 'leave.rejected' | 'employee.hired' | 'onboarding.started' | 'onboarding.completed' | 'offboarding.started' | 'offboarding.completed'
    title             TEXT NOT NULL,
    body              TEXT,
    entity_type       TEXT NOT NULL,             -- 'leave_request' | 'job_candidate' | 'onboarding_plan' | ...
    entity_id         UUID NOT NULL,
    is_read           BOOLEAN NOT NULL DEFAULT false,
    read_at           TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
    ON notifications (tenant_id, recipient_user_id, is_read, created_at DESC);