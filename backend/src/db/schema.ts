import { readFile } from 'node:fs/promises'

/** Minimal executor surface used by the bootstrap/migration code. */
export interface SqlExecutor {
  query<R = Row>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
  exec(sql: string, params?: unknown[]): Promise<void>
}

export interface Row {
  [column: string]: unknown
}

/**
 * The canonical Phase 0/1 DDL lives one level above `backend/` and is kept
 * pristine. At bootstrap we apply a small compatibility transform:
 *  - drop `CREATE EXTENSION` lines (uuid-ossp/pgcrypto are optional; PGlite
 *    lacks them, and real Postgres provides gen_random_uuid() built in)
 *  - swap `uuid_generate_v4()` for the built-in `gen_random_uuid()` (PG13+)
 *
 * Security posture of the original schema is preserved and hardened:
 *  - RLS enabled + FORCE on every tenant-scoped table
 *  - policies grant USING for SELECT/UPDATE/DELETE AND WITH CHECK for INSERT,
 *    so a request can never write rows belonging to another tenant
 *  - all tenant-scoped tables are owned by a non-superuser `app_rls_user`
 *    (superusers bypass RLS; FORCE makes even the owner subject to it)
 *  - audit_logs is INSERT/SELECT only (REVOKE UPDATE/DELETE)
 */

export const APP_ROLE = 'app_rls_user'

/** A dedicated tenant schema name: `tn_` + 32 lowercase hex chars (sha256 of the tenant id). */
export const SCHEMA_RE = /^tn_[a-f0-9]{32}$/

/** Accepts only the shared `public` schema or a derived dedicated schema name. */
export function assertSchemaName(schemaName: string): void {
  if (schemaName !== 'public' && !SCHEMA_RE.test(schemaName)) {
    throw new Error(
      `Invalid schema name "${schemaName}" — expected 'public' or a derived tn_<sha256> name`,
    )
  }
}

export const TENANT_SCOPED_TABLES = [
  'user_accounts',
  'roles',
  'user_roles',
  'refresh_tokens',
  'departments',
  'locations',
  'employees',
  'employment_history',
  'compensation_records',
  'leave_types',
  'leave_balances',
  'leave_requests',
  'attendance_records',
  'audit_logs',
  'idempotency_keys',
  // Phase 2 — Recruitment / ATS. Added to the canonical list so the existing
  // hardenRls pass (called from applyAtsSchema) picks them up idempotently.
  'job_openings',
  'job_candidates',
  // Phase 2 — Onboarding / Offboarding checklists.
  'onboarding_templates',
  'onboarding_template_tasks',
  'onboarding_plans',
  'onboarding_tasks',
  // Phase 2 — In-app notifications.
  'notifications',
  // Phase 2 — Billing & metering.
  'subscriptions',
  'usage_events',
  // Phase 3 — AI Agent: policy documents + pgvector embeddings.
  'policy_documents',
  'policy_document_chunks',
  // Phase 4 — Payroll.
  'payroll_runs',
  'payslips',
  // Phase 4 — Performance Management.
  'goals',
  'review_cycles',
  'cycle_goals',
  'performance_reviews',
  'feedback_entries',
  // Phase 4 — Benefits Administration.
  'benefit_plans',
  'enrollment_periods',
  'benefit_enrollments',
  'benefit_dependents',
  'enrollment_dependents',
  'life_events',
  // Phase 4 — Integration Hub.
  'integration_connections',
]

/**
 * Tables fully collapsed at purge. `refresh_tokens` is deliberately absent —
 * it is the global session registry (§4.5) and the one documented retention:
 * purge clears only its expired/revoked rows and keeps active ones until TTL.
 */
export const TENANT_PURGED_TABLES: readonly string[] = TENANT_SCOPED_TABLES.filter(
  (t) => t !== 'refresh_tokens',
)

/** Extra DDL appended after the canonical schema (extensions to the Phase 0/1 surface). */
export const EXTRA_DDL = `
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    key             TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    response_status INT,
    response_body   JSONB,
    response_error  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    UNIQUE (tenant_id, key)
);
`

export function transformSchema(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*CREATE\s+EXTENSION/i.test(line))
    .join('\n')
    .replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()')
}

export async function applyBaseSchema(exec: SqlExecutor): Promise<void> {
  const canonicalUrl = new URL('../../../phase0-1-schema.sql', import.meta.url)
  const canonical = await readFile(canonicalUrl, 'utf8')
  await exec.exec(transformSchema(canonical))
  await exec.exec(EXTRA_DDL)
  await exec.exec(createRoleSql())
}

/**
 * Phase 2 migrations. The DDL uses `IF NOT EXISTS`; the hardening pass that
 * follows is itself idempotent (ownership transfer, policy (re)creation, FORCE
 * RLS) and now covers the ATS tables via TENANT_SCOPED_TABLES. These are gated
 * by an explicit marker (see ensureMigrationTable / Db.open) so they run once
 * per version instead of re-doing the whole DDL + hardening on every boot.
 */
export async function applyAtsSchema(exec: SqlExecutor): Promise<void> {
  const atsUrl = new URL('../../../phase2-ats.sql', import.meta.url)
  const ats = await readFile(atsUrl, 'utf8')
  await exec.exec(transformSchema(ats))
  await hardenRls(exec)
}

/**
 * Phase 2 migration 2 — Onboarding/Offboarding checklists. Same mechanism as
 * applyAtsSchema: `IF NOT EXISTS` DDL + an idempotent hardening re-run so every
 * environment (fresh or existing) converges on the latest schema + RLS.
 */
export async function applyOnboardingSchema(exec: SqlExecutor): Promise<void> {
  const onboardingUrl = new URL('../../../phase2-onboarding.sql', import.meta.url)
  const onboarding = await readFile(onboardingUrl, 'utf8')
  await exec.exec(transformSchema(onboarding))
  await hardenRls(exec)
}

/**
 * Phase 2 migration 3 — In-app notifications. Same mechanism as the other
 * Phase 2 migrations: `IF NOT EXISTS` DDL + idempotent RLS hardening re-run.
 */
export async function applyNotificationsSchema(exec: SqlExecutor): Promise<void> {
  const url = new URL('../../../phase2-notifications.sql', import.meta.url)
  await exec.exec(transformSchema(await readFile(url, 'utf8')))
  await hardenRls(exec)
}

/**
 * Phase 2 migration 4 — Billing & metering. Same mechanism as the other
 * Phase 2 migrations: `IF NOT EXISTS` DDL + idempotent RLS hardening re-run.
 */
export async function applyBillingSchema(exec: SqlExecutor): Promise<void> {
  const url = new URL('../../../phase2-billing.sql', import.meta.url)
  await exec.exec(transformSchema(await readFile(url, 'utf8')))
  await hardenRls(exec)
}

/**
 * Phase 3 migration — AI Agent layer. Policy document tables + pgvector
 * embeddings for RAG search. Same mechanism: `IF NOT EXISTS` DDL + hardening.
 *
 * pgvector extension must be created before the DDL — transformSchema strips
 * CREATE EXTENSION lines (designed for uuid-ossp/pgcrypto), so we handle it
 * here explicitly.
 */
export async function applyAiSchema(exec: SqlExecutor): Promise<void> {
  // Create the pgvector extension if not present.
  await exec.exec(`CREATE EXTENSION IF NOT EXISTS vector`)
  const url = new URL('../../../phase3-ai.sql', import.meta.url)
  await exec.exec(transformSchema(await readFile(url, 'utf8')))
  await hardenRls(exec)
}

/**
 * Phase 4 migration — Payroll module. Payroll runs + payslips. Reads from
 * compensation_records (Phase 0/1). Same mechanism: IF NOT EXISTS DDL + hardening.
 */
export async function applyPayrollSchema(exec: SqlExecutor): Promise<void> {
  const url = new URL('../../../phase4-payroll.sql', import.meta.url)
  await exec.exec(transformSchema(await readFile(url, 'utf8')))
  await hardenRls(exec)
}

/**
 * Phase 4 migration — Performance Management module. Goals, review cycles,
 * performance reviews, and continuous feedback. Reads from employees (Phase 0/1).
 */
export async function applyPerformanceSchema(exec: SqlExecutor): Promise<void> {
  const url = new URL('../../../phase4-performance.sql', import.meta.url)
  await exec.exec(transformSchema(await readFile(url, 'utf8')))
  await hardenRls(exec)
}

/**
 * Phase 4 migration — Benefits Administration module. Benefit plans, enrollment
 * periods, employee elections, dependents, and life events.
 */
export async function applyBenefitsSchema(exec: SqlExecutor): Promise<void> {
  const url = new URL('../../../phase4-benefits.sql', import.meta.url)
  await exec.exec(transformSchema(await readFile(url, 'utf8')))
  await hardenRls(exec)
}

/**
 * Phase 4 migration — Integration Hub module. Third-party credential storage
 * and outbound dispatch.
 */
export async function applyIntegrationsSchema(exec: SqlExecutor): Promise<void> {
  const url = new URL('../../../phase4-integrations.sql', import.meta.url)
  await exec.exec(transformSchema(await readFile(url, 'utf8')))
  await hardenRls(exec)
}

/**
 * Phase 5 migration — SSO/OIDC integration. Adds sso_config_json to tenants.
 */
export async function applySsoSchema(exec: SqlExecutor): Promise<void> {
  const url = new URL('../../../phase5-sso.sql', import.meta.url)
  await exec.exec(transformSchema(await readFile(url, 'utf8')))
  await hardenRls(exec)
}

/**
 * Phase 5 migration — Dedicated per-tenant tier. Adds the platform state the
 * migration machine depends on, all idempotent (`IF NOT EXISTS` / `ADD COLUMN
 * IF NOT EXISTS`) so a crash between DDL and marker-persist converges on the
 * next boot:
 *  - `tenant_migrations` — global state machine ledger (no RLS policy of its
 *    own: platform state, same posture as `schema_migrations`).
 *  - partial unique index: one in-flight migration per tenant.
 *  - `tenants.isolation_mode` / `dedicated_schema` (plus reserved, unused
 *    `dedicated_region`).
 * No hardening pass: the new table is global and explicitly unpolicied.
 */
export async function applyDedicatedTierSchema(exec: SqlExecutor): Promise<void> {
  await exec.exec(`CREATE EXTENSION IF NOT EXISTS vector`)
  await exec.exec(`
CREATE TABLE IF NOT EXISTS tenant_migrations (
    migration_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id),
    isolation_from    TEXT NOT NULL DEFAULT 'shared',
    isolation_to      TEXT NOT NULL DEFAULT 'dedicated_schema',
    status            TEXT NOT NULL DEFAULT 'prepared',  -- prepared|copying|verifying|cutover|purged|failed|aborted|rolled_back
    schema_name       TEXT,
    manifest_json     JSONB,                             -- per-table row count + checksum snapshot
    verification_json JSONB,                             -- per-table verification result
    status_before     JSONB,                             -- pre-flight state saved for rollback
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    got_into_cutover_at TIMESTAMPTZ,
    purged_at         TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_migrations_inflight
    ON tenant_migrations (tenant_id)
    WHERE status NOT IN ('purged', 'failed', 'aborted', 'rolled_back');
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS isolation_mode TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dedicated_schema TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dedicated_region TEXT;
`)
}

/**
 * Phase 5 dedicated-tier auth follow-up. The session registry
 * (`public.refresh_tokens`, §4.5) is platform state, the same way
 * `schema_migrations` is — but its `user_id` FK pointed at the tenant-scoped
 * `public.user_accounts` row that purge collapses, which both cascaded away
 * the actively-retained tokens when the user row was purged and made any
 * post-purge token insert violate the constraint. Drop that FK: identity now
 * flows through the dedicated schema, exactly like every other tenant read
 * (`tenant_id → tenants(id)` remains and is never cascaded).
 */
export async function applyDedicatedTierAuthSchema(exec: SqlExecutor): Promise<void> {
  await exec.exec(
    `ALTER TABLE public.refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_user_id_fkey`,
  )
}

function createRoleSql(): string {
  return `
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN;
    END IF;
END $$;
`
}

export async function hardenRls(exec: SqlExecutor, schemaName = 'public'): Promise<void> {
  // Runs on a SINGLE pooled connection (see Db.open). Order matters:
  //  1. grants that make the other steps legal,
  //  2. ownership transfers (needs membership + schema USAGE/CREATE for target),
  //  3. policies/force/revokes under the app role (tables are owned by it now),
  //  4. read grants for the few global tables the surface uses.
  assertSchemaName(schemaName)
  const schema = schemaName === 'public' ? 'public' : `"${schemaName}"`

  // SET ROLE / ownership transfers require membership in the target role and
  // the target must be able to enter its own schema.
  await exec.exec(`GRANT ${APP_ROLE} TO CURRENT_USER`)
  await exec.exec(`GRANT USAGE ON SCHEMA ${schema} TO ${APP_ROLE}`)
  await exec.exec(`GRANT CREATE ON SCHEMA ${schema} TO ${APP_ROLE}`)

  // Phase-2 tables may not exist yet at the moment their sibling migration's
  // hardening pass runs (applyAtsSchema → hardenRls runs before
  // applyOnboardingSchema has created the onboarding tables). Skip any table
  // that isn't present so the pass stays idempotent and order-independent.
  const existing: string[] = []
  for (const table of TENANT_SCOPED_TABLES) {
    const probe = await exec.query<{ regclass: string | null }>(
      `SELECT to_regclass($1)::text AS "regclass"`,
      [`${schemaName}.${table}`],
    )
    if (probe.rows[0]?.regclass) existing.push(table)
  }

  for (const table of existing) {
    await exec.exec(`ALTER TABLE ${schema}.${table} OWNER TO ${APP_ROLE}`)
  }

  // Policy (re)creation must run as the owner; the DB owner is a member of
  // app_rls_user, so impersonate it inside one transaction (LOCAL reverts).
  await exec.exec(`BEGIN`)
  await exec.exec(`SET LOCAL ROLE ${APP_ROLE}`)
  for (const table of existing) {
    await exec.exec(`DROP POLICY IF EXISTS tenant_isolation ON ${schema}.${table}`)
    await exec.exec(
      `CREATE POLICY tenant_isolation ON ${schema}.${table} FOR ALL
       USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
       WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid)`,
    )
    // Creating a policy does not enable RLS; the base DDL does that for its own
    // tables, but phase-2/EXTRA_DDL tables need it here (idempotent).
    await exec.exec(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`)
    await exec.exec(`ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY`)
    if (table === 'audit_logs') {
      // Keep the audit trail append-only even for its owner.
      await exec.exec(`REVOKE UPDATE, DELETE ON ${schema}.audit_logs FROM ${APP_ROLE}`)
    }
  }
  await exec.exec(`COMMIT`)

  // Global (non-tenant-scoped) tables stay owned by the bootstrap superuser.
  // Only relevant in the shared schema: the dedicated schema holds no
  // `tenants`/`permissions` copies, and its `role_permissions` is owned by
  // the app role already (explicitly re-owned during materialization).
  if (schemaName === 'public') {
    await exec.exec(`GRANT SELECT ON tenants, permissions, role_permissions TO ${APP_ROLE}`)
  }
}

/** True once RLS hardening has been applied (all tenant tables owned by the app role). */
export async function isHardeningApplied(exec: SqlExecutor, schemaName = 'public'): Promise<boolean> {
  assertSchemaName(schemaName)
  const res = await exec.query<{ hardened: boolean }>(
    `SELECT c.relowner = r.oid AS hardened
     FROM pg_class c, pg_roles r
     WHERE c.relname = 'employees' AND c.relnamespace = $1::regnamespace
       AND r.rolname = '${APP_ROLE}'`,
    [schemaName],
  )
  return res.rows[0]?.hardened ?? false
}

/** True when the base schema has already been applied to this database. */
export async function isSchemaApplied(exec: SqlExecutor): Promise<boolean> {
  const res = await exec.query<{ c: string | null }>(`SELECT to_regclass('public.tenants') AS c`)
  return res.rows[0]?.c != null
}

/**
 * Version marker for the Phase 2 migrations. Without a guard, Db.open re-ran
 * every phase's DDL + full hardening pass on each boot — hundreds of
 * per-statement round trips over the Neon pooler (~160s) that blew the e2e
 * boot hook. Recorded once, skipped afterwards (same philosophy as
 * isSchemaApplied for the base schema). First boot on an existing database is
 * still slower: the phases re-apply (idempotent `IF NOT EXISTS`) so a database
 * that never recorded the marker converges, then the marker is persisted.
 */
export async function ensureMigrationTable(exec: SqlExecutor): Promise<void> {
  await exec.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  )
}

export async function isPhase2Applied(exec: SqlExecutor, name: string): Promise<boolean> {
  const res = await exec.query<{ applied: number }>(
    `SELECT 1 AS applied FROM schema_migrations WHERE name = $1`,
    [name],
  )
  return res.rows.length > 0
}

export async function markPhase2Applied(exec: SqlExecutor, name: string): Promise<void> {
  await exec.exec(`INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name])
}