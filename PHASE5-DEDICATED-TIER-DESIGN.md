# Phase 5 — Dedicated Tenant Tier / Data Residency: Design Document

**Status:** Draft for review
**Date:** 2026-09-24
**Precedes:** Implementation (no code until this is approved)
**Scope:** The second half of the Phase 5 roadmap item ("dedicated-tenant tier, data residency options", architecture doc §16). The first half — SSO/OIDC — shipped (PHASE5-SSO-DESIGN.md).

---

## 0. Status Check — What Exists Today

This phase is a **greenfield subsystem on top of an established tenancy model**. Nothing dedicated-tier exists in code yet. What the design must build against:

| Existing piece | Location | What it means for this phase |
|---|---|---|
| Shared-schema RLS tenancy | `phase0-1-schema.sql`, `hardenRls()` in `backend/src/db/schema.ts` | Single Postgres (Neon), single `public` schema, 42 tenant-scoped tables, all `FORCE ROW LEVEL SECURITY` with `tenant_id = current_setting('app.current_tenant')::uuid`. Table ownership transferred to non-superuser `app_rls_user`. |
| `db.tenant()` | `backend/src/db/index.ts:130` | Runs every tenant-scoped query inside one transaction as `SET LOCAL ROLE app_rls_user` + `SET LOCAL app.current_tenant = <jwt.tenant>`. Every module assumes this shape. No `search_path` is touched today. |
| `db.system()` | `backend/src/db/index.ts:147` | Superuser path (RLS bypassed) used only for tenancy resolution, login, signup, seed. |
| Hardening pass | `schema.ts:238` | **Hard-coded to the `public` schema** (`to_regclass('public.' || $1)`), iterates `TENANT_SCOPED_TABLES`, transfers ownership, (re)creates policy, ENABLE+FORCE RLS, revokes UPDATE/DELETE on `audit_logs`. |
| Migration machinery | `Db.open`, `schema_migrations`, advisory lock | Phases apply as `apply*Schema(exec)` reading canonical `.sql` files under `backend/`, all relying on the default `search_path = public`. |
| Plan/billing | `billing.repo.ts` (`PLAN_SEAT_LIMITS`, `setPlan`), `subscriptions` table, `PATCH /billing/subscription/plan` | Plans `trial/core/grow/enterprise` with seat limits. **Plan changes are soft** — any admin with `billing:write` can change plan; no Stripe, no hard enforcement of `seat_limit`. |
| Audit | `backend/src/lib/audit.ts`, `audit_logs` | Append-only (no UPDATE/DELETE grants), tenant-scoped, RLS'd. `actor_type` ∈ `user \| ai_agent \| system`. |
| Reporting | `backend/src/modules/reports/reports.repo.ts` | Queries have **no `tenant_id` WHERE clauses** — tenant scoping is 100% delegated to RLS. This is load-bearing for §4. |
| Data residency placeholder | `tenants.region` (`'us-east-1'` default) | Column exists; nothing reads it. Architecture §10 lists "region-pinned deployments" as a config-not-rewrite goal. **One region is deployed.** |
| Arch doc upgrade path | Architecture §4 | "Schema-per-tenant or DB-per-tenant for enterprise/regulated customers … offer as a paid 'dedicated' tier." |

**Verdict:** the substrate supports a schema-per-tenant tier with modest, well-contained changes. DB-per-tenant would be a much larger operational lift and is not justified by any customer requirement in hand.

---

## 1. What "Dedicated" Means This Phase

### 1.1 Recommendation: schema-per-tenant, not DB-per-tenant

Architecture §4 names two upgrade paths. They are not equal today:

| | Schema-per-tenant | DB-per-tenant |
|---|---|---|
| Physical isolation | Separate namespace within the same Postgres instance | Separate database (own connection strings, own migration runs, own backup/PITR, own monitoring) |
| Connection model | **Unchanged** — one `DATABASE_URL`, one pool, one `Db` | New per-tenant pool registry, connection-string secret management, connection multiplexing over Neon pooler, TLS per DB |
| Migration pipeline | Reuse the existing `apply*Schema` + `hardenRls` mechanism per schema (parameterized) | Full per-DB migration runner, `schema_migrations` per DB, ordering across DBs |
| Backup / PITR | Inherits instance-level Neon PITR and automated snapshots (already in place) | Per-DB backup products, restore drills per tenant — new operational burden |
| RLS | Keep `app.current_tenant` + FORCE RLS **inside** the dedicated schema (defense in depth) | RLS less critical (instance-level isolation) but still recommended against leaked cross-DB queries |
| Data residency | A physical container whose placement could later be pinned to a region — but no region routing exists or is wanted yet (§5) | Stronger placement story, but meaningless until there is a second region to pin to |
| Build/operational cost | Schema creation + one generalized hardening function + a route/flip + copy/verify/cutover | All of the above **plus** connection, migration, and backup infrastructure |

**Decision: this phase builds schema-per-tenant.** DB-per-tenant is explicitly deferred (§6). Rationale, plainly: schema-per-tenant delivers the commercial value in Phase 5 — an isolated, audited, per-tenant namespace on the same instance and pool the platform already operates — for a fraction of the operational lift. DB-per-tenant adds infrastructure (connections, migrations, backups, monitoring per tenant) that only pays off when a single tenant genuinely needs instance-level isolation or, later, its own region. There is no signed customer behind this phase demanding that lift, so building it now is speculation.

### 1.2 What "dedicated" does and does not buy

- **Buys:** a physically separate schema namespace for the tenant's 42 tenant-scoped tables; a hard boundary at the namespace level in addition to RLS; a foundation for region pinning later; a defensible enterprise/conpliance answer ("your data lives in its own schema, isolated by namespace AND RLS for every query").
- **Does not buy (yet):** a separate Postgres instance, separate backups, a second region, or a different physical disk. All tenants still share the same instance, same PITR, same blast radius for instance-level incidents. That is honest for our scale: schema-per-tenant is isolation from *other tenants*, not from *platform outages*.

---

## 2. Registry & Data Model Changes

### 2.1 `tenants` gains an isolation mode

```sql
ALTER TABLE tenants
  ADD COLUMN isolation_mode         TEXT NOT NULL DEFAULT 'shared', -- 'shared' | 'dedicated_schema'
  ADD COLUMN dedicated_schema       TEXT,                           -- schema name once dedicated
  ADD COLUMN dedicated_region       TEXT;                           -- NULL; reserved for §5
```

- `isolation_mode = 'shared'` is the status quo for every existing tenant. Nothing migrates by default.
- `dedicated_schema = 'tn_' || replace(tenant_id::text, '-', '')` — derived from the tenant UUID, not the subdomain (subdomains can change; UUIDs don't). PostgreSQL identifiers cannot contain hyphens, hence the `replace`.
- These columns are global (like `tenants` itself) and stay owned by the bootstrap role, readable by `app_rls_user` (already granted).

### 2.2 What the dedicated schema contains — and how its DDL is generated

Exactly the 42 tables in `TENANT_SCOPED_TABLES` (`schema.ts:31`) — **plus one deliberate, load-bearing exception** — and it must **not** contain `tenants` or `permissions` (the global registry, copied by no one). The exception is `role_permissions` (Landmine A below): it has no `tenant_id` column, so it is excluded from the RLS-harnessed set like a global table, but its rows are tenant-derived (each row maps a tenant-scoped `roles.id` to a global `permissions.id`), and a dedicated tenant's mappings must live **in its own schema** or the purge cascade silently deletes them (§3.3 Step 5, §3.3 Step 2, §9). `tenants` and `permissions` are never copied.

The two landmines this phase carries are both on the **prepare** path (Step 1, §3.3), and both are resolved here rather than left as warnings.

#### Landmine A — no local copy of the global registry (DDL generation)

**The trap:** the canonical phase SQL files resolve FKs like `REFERENCES tenants(id)` via `search_path = public`. If they were replayed verbatim with `search_path = <tn>` they would resolve — or, worse with `<tn>, public`, fall through to `public.tenants` *only because `<tn>` happens to have no `tenants` table yet*. That fall-through is order-dependent and silently flips to a local copy the moment one is ever created. Replaying is not acceptable even when it happens to bind correctly, because the binding is implicit.

**The mechanism — generated from one canonical source, with explicit qualification:**

```ts
// backend/src/db/dedicated-schema.ts (new module)

// The ONLY relations a tenant-scoped table may FK to that are NOT tenant-scoped.
// Keep this list closed: every entry must be a global table in `public`.
export const GLOBAL_FK_TARGETS = ['tenants', 'permissions'] as const

export const SCHEMA_RE = /^tn_[a-f0-9]{32}$/  // tn_<uuid v4 minus hyphens>

export function assertSchemaName(schema: string): void {
  if (schema !== 'public' && !SCHEMA_RE.test(schema)) {
    throw new Error(`Refusing to run against untrusted schema name: ${schema}`)
  }
}

/**
 * Identifier-boundary rewrite of global FK targets in the CANONICAL phase SQL
 * (the same `readFile` + `transformSchema` text the shared schema applies).
 *
 * Rules, applied on a lowercase-normalized match with a word boundary:
 *   REFERENCES tenants(...)    -> REFERENCES public.tenants(...)
 *   REFERENCES permissions(...) -> REFERENCES public.permissions(...)
 *
 * Nothing else is touched. A column named `tenants`/`permissions`, a table
 * named `tenants_id`, `REFERENCES` inside a `--` comment, or any
 * intra-tenant target (`roles`, `employees`, ...) passes through unmodified.
 * The replacement text only ever comes from the GLOBAL_FK_TARGETS allowlist,
 * never from input, so this helper cannot inject schema names.
 */
export function rewriteGlobalFkTargets(sql: string): string {
  const re = /\bREFERENCES\s+("?)(tenants|permissions)\1\s*\(/gi
  return sql.replace(re, (_m, _q: string, tbl: string) => `REFERENCES public.${tbl}(`)
}

// Self-referential FKs: the complete, closed set of FK columns whose target
// table is the table that defines them. A closed list + golden-file assert —
// it cannot quietly grow.
export const SELF_REFERENTIAL_FKS = {
  employees:   ['manager_employee_id'],  // schema.ts SQL: employees(id)
  departments: ['parent_id'],            // schema.ts SQL: departments(id)
} as const

/**
 * Runs BEFORE rewriteGlobalFkTargets as the first DDL pass.
 * Contract: within `CREATE TABLE <enclosing>`, any `REFERENCES <target>(`
 * where <target> === <enclosing> is a self-reference and is emitted as
 * `REFERENCES <target>(…) DEFERRABLE INITIALLY IMMEDIATE` (validated at
 * COMMIT, not per statement — §3.3 Step 2). Every other FK stays
 * NOT DEFERRABLE (immediate), which keeps parent-before-children copy order
 * load-bearing. Nothing else is modified; the output is pinned by the golden
 * file, so the DEFERRABLE set cannot grow beyond the two self-references.
 */
export function makeSelfRefFksDeferrable(sql: string): string {
  // Runs before rewriteGlobalFkTargets. Contract: within each `CREATE TABLE
  // <enclosing>(…)` statement, every `REFERENCES <target>(…cols…)` where
  // <target> === <enclosing> is a self-reference and is emitted as
  // `REFERENCES <target>(…cols…) DEFERRABLE INITIALLY IMMEDIATE`. All other
  // FKs are left exactly as-is (immediate). The implementation walks the
  // parsed statement list; its exact output is pinned by the golden file, so
  // the DEFERRABLE set can never grow beyond the two self-references without
  // a reviewed diff.
  const tableRe = /\bCREATE TABLE\s+(IF NOT EXISTS\s+)?([a-z_]+)\s*\(([\s\S]*?)\)\s*;/gi
  return sql.replace(tableRe, (whole: string, _ifx: string | undefined, name: string, body: string) => {
    if (!Object.keys(SELF_REFERENTIAL_FKS).includes(name)) return whole
    const deferred = body.replace(
      new RegExp(`(REFERENCES\\s+${name}\\s*\\([^)]*\\))`, 'gi'),
      `$1 DEFERRABLE INITIALLY IMMEDIATE`,
    )
    return whole.replace(body, deferred)
  })
}
```

- **One source of truth:** the dedicated schema's table shapes are *not* a parallel hand-written DDL that can drift. `materializeDedicatedSchema()` (below) reads the exact same `phase*.sql` canonical files the shared schema uses (same `readFile`, same `transformSchema`), applies the per-statement pipeline **`makeSelfRefFksDeferrable()` → `rewriteGlobalFkTargets()`** (§2.2 code above), and executes the text with `search_path = <tn>, public` (via `set_config('search_path', …, true)` on the bootstrap connection). Tenant-scoped FK targets then resolve inside `<tn>`; the rewritten globals resolve to `public` explicitly. Nothing is implicitly bound and nothing is hand-paraphrased.
- **`role_permissions` — the exception, and it is deliberate:** it never appears in the tenant-scoped DDL set, so its table is **derived from the same canonical statement** with explicit binding: `REFERENCES roles(id)` → `REFERENCES <tn>.roles(id)` (binds to the tenant's own roles — the copy the purge cascade cannot reach) and `REFERENCES permissions(id)` → `REFERENCES public.permissions(id)` (global, never purged). It gets **no** RLS policy — there is no `tenant_id` column to scope on, identical posture to `public.role_permissions` today; isolation is by construction, because only this tenant's mapping rows are ever copied into it. Ownership transfers to `app_rls_user` explicitly (§3.3 Step 1), since `hardenRls`'s owner loop only iterates `TENANT_SCOPED_TABLES`. A stray copy of `tenants` or `permissions` in `<tn>` remains a hard failure.
- **Self-referential FKs become DEFERRABLE — and only they do:** `employees.manager_employee_id → employees(id)` and `departments.parent_id → departments(id)` (a closed set, `SELF_REFERENTIAL_FKS`) are emitted as `REFERENCES … DEFERRABLE INITIALLY IMMEDIATE` so a batched copy can insert a whole table and let the within-table check run at `COMMIT`, not per row (§3.3 Step 2). Every other FK stays `NOT DEFERRABLE` (immediate), which is what makes parent-before-child copy order load-bearing rather than stylistic.
- **Table ownership:** `CREATE SCHEMA <tn> AUTHORIZATION app_rls_user` means the schema's objects are owned by the same non-superuser role that owns the shared tables — one ownership model, one `FORCE RLS` posture, an audit log with the same `REVOKE UPDATE, DELETE` for the tenant's copy.
- **Not assumed correct — proven twice over:**
  1. **Unit/CI proof** (`dedicated-schema.test.ts`): run the full pipeline (`transformSchema` → `makeSelfRefFksDeferrable` → `rewriteGlobalFkTargets` + the `role_permissions` derivation) over every real canonical source file and assert (a) no *live* statement (comment-aware) contains an unqualified `REFERENCES (tenants|permissions)\s*(`; (b) the only `DEFERRABLE`-touched references are the two self-edges in `employees`/`departments`; and (c) the rewritten output is diffed against a **checked-in golden file** — so any future edit to canonical DDL that alters the FK graph or the deferrable set becomes a reviewed diff, not silent drift.
  2. **Migration-time proof** (runs inside every migration, not a one-off — see §3.3 Step 1 / §3.5 check 5): after materialization, query `pg_constraint` for the new schema and assert (a) **zero** objects named `tenants` / `permissions` exist in `<tn>`; (b) `role_permissions` exists in `<tn>` **exactly once**, with `role_id` → `<tn>.roles(id)` and `permission_id` → `public.permissions(id)`; (c) **every** FK whose target is a non-tenant table resolves to `public`; and (d) the only `DEFERRABLE` FK constraints in `<tn>` are the two self-references (`employees.manager_employee_id`, `departments.parent_id`). A missed rewrite, a future new global table added to a phase file, an accidental local copy, or a drift in the deferrable set all fail here deterministically.

### 2.3 Landmine B — `hardenRls` is hard-coded to `public`

`hardenRls()` (`schema.ts:238`) and `isHardeningApplied()` (`schema.ts:295`) both assume the `public` namespace: the table-existence probe hard-codes `'public.' || $1` and the applied-check compares `c.relnamespace = 'public'::regnamespace`. The shared-schema call sites must not change behavior, so the parameter defaults to `'public'` and every existing call passes nothing.

```ts
// backend/src/db/schema.ts — resolve Landmine B

export async function isHardeningApplied(
  exec: SqlExecutor,
  schema = 'public',
): Promise<boolean> {
  assertSchemaName(schema)                                   // from §2.2: 'public' OR tn_<uuid>
  const res = await exec.query<{ hardened: boolean }>(
    `SELECT c.relowner = r.oid AS hardened
     FROM pg_class c, pg_roles r
     WHERE c.relname = 'employees'
       AND c.relnamespace = to_regnamespace($1)
       AND r.rolname = '${APP_ROLE}'`,
    [schema],
  )
  return res.rows[0]?.hardened ?? false
}

export async function hardenRls(
  exec: SqlExecutor,
  schema = 'public',
): Promise<void> {
  assertSchemaName(schema)
  // 1. grants are per-schema; role membership stays global.
  await exec.exec(`GRANT ${APP_ROLE} TO CURRENT_USER`)
  await exec.exec(`GRANT USAGE ON SCHEMA ${schema} TO ${APP_ROLE}`)
  await exec.exec(`GRANT CREATE ON SCHEMA ${schema} TO ${APP_ROLE}`)

  const existing: string[] = []
  for (const table of TENANT_SCOPED_TABLES) {
    const probe = await exec.query<{ regclass: string | null }>(
      `SELECT to_regclass($1)::text AS "regclass"`,
      [`${schema}.${table}`],
    )
    if (probe.rows[0]?.regclass) existing.push(table)
  }

  for (const table of existing) {
    await exec.exec(`ALTER TABLE ${schema}.${table} OWNER TO ${APP_ROLE}`)
  }

  await exec.exec(`BEGIN`)
  await exec.exec(`SET LOCAL ROLE ${APP_ROLE}`)
  for (const table of existing) {
    await exec.exec(`DROP POLICY IF EXISTS tenant_isolation ON ${schema}.${table}`)
    await exec.exec(
      `CREATE POLICY tenant_isolation ON ${schema}.${table} FOR ALL
       USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
       WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid)`,
    )
    await exec.exec(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`)
    await exec.exec(`ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY`)
    if (table === 'audit_logs') {
      await exec.exec(`REVOKE UPDATE, DELETE ON ${schema}.audit_logs FROM ${APP_ROLE}`)
    }
  }
  await exec.exec(`COMMIT`)

  // Global tables stay global: these grants are against `public` only, once,
  // and are never repeated per schema.
  await exec.exec(`GRANT SELECT ON tenants, permissions, role_permissions TO ${APP_ROLE}`)
}
```

Call-site inventory — **11 existing call sites, all unchanged** (`schema === 'public'`):

| Call site | Today | After |
|---|---|---|
| `applyAtsSchema`, `applyOnboardingSchema`, `applyNotificationsSchema`, `applyBillingSchema`, `applyAiSchema`, `applyPayrollSchema`, `applyPerformanceSchema`, `applyBenefitsSchema`, `applyIntegrationsSchema`, `applySsoSchema` (`schema.ts:127,139,149,159,175,185,195,205,215,224`) | `hardenRls(exec)` | `hardenRls(exec)` — identical |
| `Db.open` (`db/index.ts:89`) + `isHardeningApplied(q)` (`db/index.ts:88`, `schema.ts:295`) | `hardenRls(q)` / `isHardeningApplied(q)` | identical |

The **only new call site** is the dedicated-schema materialization in §3.3 Step 1:

```ts
await materializeDedicatedSchema(exec, schemaName)   // eligible only AFTER assertSchemaName
// ...which internally does:
await hardenRls(exec, schemaName)                    // per-schema hardening
await isHardeningApplied(exec, schemaName)           // per-schema applied guard (idempotent retry)
```

`assertSchemaName` is the security boundary on both functions: the `schema` identifier is interpolated into DDL, so it must come from one of exactly two shapes — the constant `'public'`, or a tenant UUID-derived `tn_<32 hex>` — and never from a user-supplied string. The derived form is computed in one helper (`schemaNameForTenant(tenantId)`), so nothing else in the codebase ever hand-builds a schema name.

---

## 3. Migration Mechanics — The Highest-Risk Part

**Threat model:** a botched tenant migration either loses data or crosses a tenant boundary. Both are unacceptable; this is treated with the same rigor as the Phase 0 RLS hardening pass — identity-boundary-level risk, not a routine schema change.

### 3.1 Guiding invariant

> **The shared schema remains the source of truth until the cutover is verified. Nothing is ever moved in place. Migration = Copy → Verify → Atomic Flip → (delayed) Purge.**
>
> **Quiescence is part of the invariant, not a nice-to-have:** the tenant's `status` is set to `migrating` **before the manifest is captured** (§3.3 Step 0), so the source cannot diverge from the manifest between the snapshot, the copy, and the flip. There is no "verification passed against a source that later changed" state — the source stops accepting writes the moment the ground truth is fixed, and that frozen state is what the copy, the verify, and the cutover all read (§3.4).

The tenant's rows in `public` are never modified by the copy phase, so every step before the flip is reversibility-free by construction.

### 3.2 Operation shape: an explicit state machine

Migration is a single admin-triggered operation with a persistent state machine — not a script, not a cron, not self-service. Every transition is audited (§7). States:

```
┌──────────┐   trigger: admin POST + enterprise check + locks   ┌──────────┐
│ prepared │ ──────────────────────────────────────────────────▶ │ copying  │
└──────────┘                                                     └──────────┘
   ▲   ▲                                                              │
   │   │ retry after failure                                            ▼
   │   └───────────── abort (restore shared state)               ┌──────────┐
   │                                                           │ verifying│
   │                                                            └──────────┘
   │                                                               │  │
   │                                                          OK  │  │ mismatch
   │                                                               ▼  ▼
   │                                                            ┌──────────┐
   │                                                            │  failed  │ ──▶ DROP schema, stay shared (audited)
   │                                                            └──────────┘
   │                                                               │ flip: read-only window
   │                                                               ▼
   │                                                            ┌──────────┐
   │                                                            │  cutover │ ──▶ isolation_mode='dedicated_schema' (atomic)
   │                                                               │
   │                                                               ▼
   │   reverse                                                    ┌──────────┐
   └───────────────────────────────────────────────────────────── │  purged  │ ◀── purge shared rows (delayed, separate step)
                                                                  └──────────┘
```

A new **global** table records it (like `schema_migrations` — platform state, not tenant state, no RLS policy of its own):

```sql
CREATE TABLE tenant_migrations (
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
```

**Concurrency guard:** one in-flight migration per tenant. Enforced by a partial unique index (`WHERE status NOT IN ('purged','failed','aborted','rolled_back')`) plus a per-tenant Postgres advisory lock taken at the start — the same lock discipline `Db.open` already uses.

### 3.3 Step-by-step

**Step 0 — Preflight (admin-triggered, audited).**
- Tenant exists, `status='active'`, `isolation_mode='shared'`, subscription `plan='enterprise'` and `status='active'` (§4).
- Permission: admin-only (see §4.3).
- Capture `status_before` (tenant row + subscription row JSON) for rollback.
- **Open the read-only window first: update `tenants.status` → `'migrating'` and confirm it took effect, *before* any snapshot or copy (§3.4).** This is the point after which the source cannot change, which is precisely the property the manifest depends on.
- Build the `manifest_json`: for each of the 42 tenant tables **plus the join-filtered `role_permissions` set** (rows whose `role_id` is in the tenant's `roles`), `SELECT count(*)` and **the pinned checksum** `md5(coalesce(string_agg(md5(t::text), '' ORDER BY t::text), ''))` per table. The expression is pinned over the two candidate formulations because it is **extension-free core Postgres** (`hashes.md5` needs the non-bundled `pgcrypto`; `md5(string_agg(t::text, '|'))` is delimiter-ambiguous since `|`, backslash-escaping, or a row whose text renders `'a|b'` vs two rows `'a','b'` both yield the same suffix string). Per-row `md5(t::text)` is a fixed 32-char hex string, so concatenation in a **total order** (`ORDER BY t::text` — a valid total order on distinct rows, `t::text` is unique per row since distinct rows always differ in some column's rendering) is unambiguous; `coalesce(..., '')` covers empty tables as `md5('') = d41d8cd98f00b204e9800998ecf8427e`. **The identical SQL text is used on both sides**: manifest over `public.<table>` with a tenant filter (Steps 0/3), verify over `<tn>.<table>` with no filter (Step 3) — same per-table column order, guaranteed by the canonical DDL, so the two aggregates are directly comparable. This is the ground truth the copy will be verified against.

**Step 1 — Prepare.**
- `materializeDedicatedSchema(exec, schemaName)` on the bootstrap connection (same model as `Db.open`'s single checked-out connection — not `db.tenant`/`db.system`, because `hardenRls` manages its own `BEGIN…COMMIT`):
  1. `assertSchemaName(schemaName)` (§2.3) — refuse anything that isn't `'public'` or the derived `tn_<uuid>` form.
  2. `CREATE SCHEMA <schemaName> AUTHORIZATION app_rls_user`.
  3. Apply the canonical phase DDL for the 42 tenant tables (`set_config('search_path', '<tn>, public', true)` → `transformSchema(<each phase*.sql source>)` → **`makeSelfRefFksDeferrable(...)` → `rewriteGlobalFkTargets(...)`** (§2.2)), **then create `<tn>.role_permissions` from its canonical statement with explicit binding: `REFERENCES roles(id)` → `REFERENCES <tn>.roles(id)`, `REFERENCES permissions(id)` → `REFERENCES public.permissions(id)`, `PRIMARY KEY (role_id, permission_id)`** (§2.2).
  4. `await hardenRls(exec, schemaName)` (§2.3), then `await isHardeningApplied(exec, schemaName)` as the idempotent applied-guard so a retry after a crash never double-hardens. **`<tn>.role_permissions` is excluded from the RLS policy loop by design — it has no `tenant_id` (identical posture to `public.role_permissions`) — and is explicitly re-owned**: `ALTER TABLE <tn>.role_permissions OWNER TO app_rls_user`, because `hardenRls`'s owner loop only iterates `TENANT_SCOPED_TABLES`.
  5. **FK-target catalog assertion** (the migration-time proof from §2.2): query `pg_constraint` — `tenants`/`permissions` absent from `<tn>`; `role_permissions` present exactly once with `role_id → <tn>.roles` and `permission_id → public.permissions`; every FK targeting a non-tenant table resolves to `public`; the only `DEFERRABLE` constraints are the two self-references.
- Result: 42 tables + the `role_permissions` copy, owned by `app_rls_user`, the 42 under `FORCE RLS` with the identical `current_setting('app.current_tenant')::uuid` policy and same `audit_logs` UPDATE/DELETE revoke, `role_permissions` deliberately unpolicied (isolated by construction) — none of it assumed, all of it asserted before the first row is copied.
- State → `copying`.

**Step 2 — Copy (data at rest; the tenant serves reads only, §3.4).**
- Copy per table **in FK dependency order — parents before children.** Postgres checks non-deferrable FKs immediately, per statement, so the referenced row must exist before the referencing row; the canonical DDL's creation order is already FK-dependency-ordered and the copy follows it. (The "children before parents" order the seed's reset maintains is a *delete/teardown* order — correct for purge and rollback, inverted for fresh-schema population. There is no deferred-constraint mechanism behind the old wording; the order is load-bearing.)
- Batched `INSERT … SELECT` in chunks (e.g. 5,000 rows) per table inside a transaction; per-table transaction (the whole set is too large for one transaction on Neon and would blow connection/statement limits). Preserve **all UUIDs** — nothing is regenerated, so intra-schema FKs stay valid and rows remain referentially identical to the public copies.
- **Self-referential FKs are handled by deferral, not by ordering:** `employees` and `departments` are each copied in a transaction that begins `BEGIN; SET CONSTRAINTS ALL DEFERRED; <batched inserts>; COMMIT;`. Their within-table constraints are `DEFERRABLE INITIALLY IMMEDIATE` (§2.2), so `manager_employee_id`/`parent_id` resolve at COMMIT — a manager need not precede their reports, nor a parent department its children, within the batch. Any *other* FK is immediate and still enforces parent-before-children hard; a dangling self-reference fails the copy transaction → `failed` (§3.3 Step 3), and the verify pass re-checks the same edges independently.
- **`role_permissions` copy (after `roles` is copied):**
  ```sql
  INSERT INTO <tn>.role_permissions (role_id, permission_id)
  SELECT rp.role_id, rp.permission_id
  FROM public.role_permissions rp
  WHERE rp.role_id IN (SELECT id FROM <tn>.roles);
  ```
  This join-filtered copy is the **fix for the open cascade**: its `role_id` FK binds to `<tn>.roles(id)`, not `public.roles(id)`. Without it, the eventual purge (`DELETE FROM public.roles` → `ON DELETE CASCADE` at `role_permissions` per `phase0-1-schema.sql:67`) would silently and permanently delete every dedicated tenant's role→permission mappings that were never copied. With it, purge removes only the stale public half and cannot reach the tenant's copy. After the flip, all app writes to `role_permissions` resolve to `<tn>` via `search_path` (§4), so the tenant's mappings stop touching `public` from cutover on.
- **Audit rows are copied too** — a dedicated tenant keeps its full history (§7).
- Because `public` rows are untouched, the copy phase is a pure read of the tenant's own data against the source already frozen in Step 0 — the manifest, copy, and verify all read the same state, and the flip completes inside the same window (§3.4).

**Step 3 — Verify.**
- For each table — **including the join-filtered `role_permissions` set** — `count(*)` and the pinned checksum (`md5(coalesce(string_agg(md5(t::text), '' ORDER BY t::text), ''))`, exactly the same SQL text as the manifest, §3.3 Step 0) must equal the `public` manifest exactly.
- FK integrity within the dedicated schema: `EXPLAIN`-free, run actual `LEFT JOIN … ON … IS NULL` anti-joins across the schema's FK edges — **including both self-referential edges on `employees` and `departments`, which the Step 2 `DEFERRABLE` COMMIT already validated (this is the independent backstop)**. The result set must be empty.
- **`role_permissions` parity is part of the gate:** per role, the mapping set in `<tn>` equals the manifest snapshot exactly — nothing lost, nothing extra (see also check 3 in §3.5).
- RLS smoke test: as `app_rls_user`, with `SET app.current_tenant` to another tenant, `SELECT` from a sample of dedicated tables must return 0 rows (negative test). With the migrating tenant set, samples must match counts.
- Any failure → **`failed`**. Implementation idempotency guarantee: on failure, DROP the dedicated schema and restore `isolation_mode='shared'` (it never left). The tenant is untouched and uninstrumented; the admin can retry with a fresh migration. Nothing is rolled forward on a mismatch, ever.

**Step 4 — Cutover (the atomic flip).**
- One row update in one transaction:
  ```sql
  UPDATE tenants SET isolation_mode = 'dedicated_schema', dedicated_schema = $1 WHERE id = $2;
  ```
- This single statement is the switch. Before it, every request routed to `public` (correct — RLS scopes it). After it, requests route to the dedicated schema via `search_path` (§4). **There is no point during the operation where the tenant has two live write targets** because the shared copy is only ever read during copy/verify and only deleted much later in purge.
- The flip executes **inside** the still-open read-only window (`status` is `'migrating'` — §3.4). Once the flip is confirmed, **close the window: restore `tenants.status` → `'active'`** so reads-and-writes resume against the dedicated schema.
- Immediately after the flip, revoke the tenant's refresh tokens and force re-auth (§4.4), and mark `got_into_cutover_at`.

**Step 5 — Purge (delayed, separate, explicit).**
- Deleting the shared-schema rows is the **point of no return** and is deliberately NOT part of the flip. A configurable grace window (default 7 days) starts at `got_into_cutover_at`; a distinct admin action (or a nightly platform job past the grace window) deletes the tenant's rows from `public` across the 42 tenant tables, then writes a `purged` audit row.
- **What the purge cascade no longer endangers:** `DELETE FROM public.roles` cascades `ON DELETE CASCADE` into `public.role_permissions` (`phase0-1-schema.sql:67`) and `public.user_roles` (`phase0-1-schema.sql:74`). That cascade is now harmless *only because* the dedicated tenant's mapping rows were copied into `<tn>.role_permissions` in Step 2 with their FK bound to `<tn>.roles` — the purge removes the stale public copy and physically cannot reach the tenant's copy. A dedicated tenant's role→permission state survives purge exactly as it was cut over.
- **One deliberate retention:** `public.refresh_tokens` is the global session registry and its token-hash lookup is inherently cross-tenant (§4.5). For a dedicated tenant the purge deletes only its **expired/revoked** rows and retains **active** ones until their TTL (`refreshExpiresDays`) — active tokens are transient session state, not tenant data, and this is the single documented exception to "the tenant's rows leave `public`."
- **Post-purge integrity check** (§9): after the purge, re-run the `<tn>.role_permissions` parity assertion against the pre-purge snapshot — per-role mapping sets must be identical, and no `<tn>.roles` row may have lost its mappings. A mismatch is a platform incident, not silent data loss.
- During the grace window, the shared copy is a live rollback source (§8.3): flip back + drop schema = zero data loss.
- The RLS policy on the shared tables makes the leftover rows invisible to everyone anyway — purge is a disk-hygiene and compliance step, not a security one. That is why a delay is safe.

### 3.4 Traffic handling during migration

**One window, and it opens earlier than it might look — by design:**

| Phase | Tenant traffic | Why |
|---|---|---|
| Step 0 (manifest capture) through the flip (Step 4) | **Read-only** (writes rejected for the tenant, reads served) | The source must be quiescent **from the moment the ground truth is fixed**. Opening the window in Step 0 — *before* the manifest snapshot — closes the divergence gap: manifest, copy, and verify all read a source that cannot change, and the flip completes inside the same window. A window that opened only at the final pass would let the source diverge between a passed verify and the cutover — exactly the race this design refuses. |
| After the flip is confirmed (Step 4) | **Normal, full read+write** | `status` restored to `'active'`; routing now goes to the dedicated schema (§4). |

Read-only enforcement is **state-based, not code-path-based**: `tenants.status = 'migrating'` is set **before** the manifest is captured (§3.3 Step 0); both `authenticate` (rejects new login for the tenant) and the request path (rejects mutations) key off it, and it is cleared only by the flip confirmation (Step 4). This is the same discipline as the existing `active | suspended | cancelled` status modeling — a status flap, not a new permission or a special flag checked in forty route handlers. The window is deliberately part of the migration, not a hidden compromise: for an admin-scheduled enterprise migration this is a short, honest maintenance window whose length is bounded by copy+verify throughput (minutes for SMB-scale tenants).

**Answering the timing question directly:** `status='migrating'` is set at the start of Step 0, before the manifest snapshot — strictly earlier than "before Step 3". Verify therefore runs against a source that has been quiescent since before the snapshot, satisfying §3.1's invariant with no gap.

### 3.5 Verification before cutover — checklist

The flip **must not execute** unless every check passes:

1. Per-table `count` + pinned checksum (Step 0's exact expression) equal the manifest (0 drift) — including the join-filtered `role_permissions` set.
2. Empty anti-join result across every FK edge in the dedicated schema — including the `employees.manager_employee_id` and `departments.parent_id` self-edges (independent backstop to the Step 2 `DEFERRABLE` COMMIT).
3. **`role_permissions` parity:** per role, the mapping set in `<tn>` equals the manifest snapshot exactly — nothing lost, nothing extra.
4. Negative RLS test (other tenant sees 0 rows) and positive RLS test (migrating tenant sees full counts) as `app_rls_user`.
5. DDL audit canary (§2.2, run in Step 1): dedicated schema contains exactly the 42 tenant-scoped tables plus one `role_permissions`; zero `tenants`/`permissions` objects; `role_permissions` FKs target `<tn>.roles` + `public.permissions`; every other FK whose target is a non-tenant table resolves to `public`; the only `DEFERRABLE` constraints are the two self-references.
6. `tenant_migrations.verification_json` recorded for auditability.

---

## 4. How the Application Layer Routes — `db.tenant()` Semantics

**Question this section answers explicitly:** does a dedicated tenant get a different connection/schema routing, and does RLS still do isolation inside the dedicated schema?

**Answer: both.** Two independent mechanisms, deliberately redundant:

1. **Routing changes** — the tenant's session `search_path` is prefixed with its dedicated schema, so every unqualified query touches the tenant's physical copy.
2. **RLS remains** — FORCEd with the identical `tenant_id = current_setting('app.current_tenant')` policy *inside* the dedicated schema, evaluating the same session variable the request already set.

`search_path` routing is a *performance and placement* mechanism ("which tables do I read"). RLS is the *isolation* mechanism ("which rows am I allowed to see"). A failure of either alone must still be safe: with RLS + wrong schema you see your own data in the wrong copy; with right schema + no RLS you'd see everything in your own copy. Both are required for the defense-in-depth posture every module already assumes (the architecture doc's "belt and suspenders").

### 4.1 The invariant every module may keep relying on

> Every tenant-scoped query runs inside a transaction where `app.current_tenant` is set from the verified JWT, RLS is FORCEd, and — for dedicated tenants — the tenant's schema is first on `search_path`, `public` second for the global tables (`tenants`, `permissions`). `role_permissions` resolves to the tenant's own copy when one exists (dedicated) and falls through to the shared one when it does not (shared) — the same table reference, never both. (`refresh_tokens` is *not* read through `search_path` in any path; the session-registry functions schema-qualify `public.refresh_tokens` directly — §4.5.)

Concretely, `db.tenant()` (`index.ts:130`) grows one line between the existing two:

```ts
await client.query(`SET LOCAL ROLE ${APP_ROLE}`)
await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId])
if (reqSchema) await client.query(`SELECT set_config('search_path', $2, true)`, [schemaName + ', public'])
```

- `SET LOCAL` reverts at COMMIT/ROLLBACK, same as today — no cross-request leakage, no pool hygiene problem.
- `public` stays on the path (second) so `tenants`, `permissions` and any future global table resolve. `role_permissions` is *first-class per tenant* after migration: it resolves to `<tn>.role_permissions` for dedicated tenants (search_path precedence) and to `public.role_permissions` for shared tenants — the same reference meeting the tenant's copy where one exists, the shared table where it does not.
- The rest of `db.tenant()`'s contract (RLS enforced, single transaction, tenant id required) is **unchanged**. Every existing route, repo, and query keeps working with zero per-module edits — including the reporting module, whose SQL contains no `tenant_id` filters and relies entirely on RLS (§0). Routing to the dedicated schema plus the same RLS expression is precisely what keeps those queries correct.

### 4.2 How the app knows the tenant's mode — the JWT is the authority

`db.tenant()` must know the tenant's `isolation_mode`/`dedicated_schema`. Two candidates:

| | Per-request `tenants` lookup | JWT claim (recommended) |
|---|---|---|
| Correct after cutover | Always (reads the row) | Stale until token refresh |
| Cost | One extra DB round trip per request (every module, every request) | Zero per-request cost — already fetched at login/refresh |
| Consistency with existing discipline | Diverges — today *everything* tenant-scoped comes from the verified JWT ("SET LOCAL must come from the JWT", `auth.ts:55`) | Matches it exactly |

**Decision: carry the mode in the JWT.** `AuthClaims` gains `isolationMode` and `tenantSchema`, populated at login/refresh/signup from the `tenants` row (auth already reads that row via `db.system`, so it is free). `authenticate()` projects them into `req.ctx`; `db.tenant()` receives `req.ctx.tenantSchema` and applies it only when present.

**The stale-token window is closed by construction:** access tokens live 15 minutes; after cutover we revoke the tenant's refresh tokens (`revokeRefreshToken` lineage, same as token rotation), so re-auth happens immediately at cutover and every subsequent token carries the dedicated schema. During the ≤15 min before a pre-cutover token expires, routing to `public` is still *correct* — RLS scopes the user to their own rows, which still exist in `public` until the grace window purge. There is no window in which a JWT can see another tenant's data, only a brief window in which it reads the tenant's own pre-migration copy.

### 4.3 Why not schema-from-database-per-request

Resisting the temptation to "just do a `SELECT isolation_mode FROM tenants` each time": that is a round trip on the hottest path in the system, duplicated at every module boundary, and it re-introduces exactly the "where does the app context come from" ambiguity the codebase already settled. The JWT claim keeps one authority for tenancy context.

### 4.4 What the cutover does to sessions

1. Flip `tenants` row (`isolation_mode`, `dedicated_schema`, `status` back to `active`).
2. Revoke all refresh tokens for the tenant (forces a fresh login → fresh JWT with the dedicated claim).
3. Serverless instances share the claim — a 15-minute access token plus forced refresh means misrouting is bounded and self-healing; a pre-purge window means it is also data-safe (§3.4, §3.3 Step 5).

### 4.5 Auth reads roles from the tenant's own schema — or purge locks the tenant out

The auth flow reads tenant-scoped rows: `findUserByEmail`/`findUserById` (`auth.repo.ts:49,121`), `listRolesForUser`/`listPermissionsForUser` (`auth.repo.ts:62,74`), and the join those share through `user_roles`, `roles`, `role_permissions`, `employees`. Login and refresh run them under `db.system` (`auth.routes.ts:29,91`), whose default `search_path` is `public`. Pre-purge this "works" only because the tenant's public rows still exist; **post-purge those rows are gone, and left as-is a dedicated tenant's login and refresh would resolve empty accounts/roles/permissions — a lockout shipped with every purge.** This is the same root cause as the role_permissions cascade (§3.3 Step 2/5): role and session state for a dedicated tenant must resolve in the tenant's own schema once cut over. Copying the table without rerouting these reads fixes the data but not the access to it.

**Mechanism:**
- `db.system(fn, opts?)` gains an optional `{ schema }`, which `assertSchemaName`s the value (§2.3) and applies the same one-line `SET LOCAL search_path = <schema>, public` as §4.1, scoped to that transaction.
- **Login** (`/auth/login`): after `findTenantBySubdomain` (a `public.tenants` read — `tenants` never lives in a tenant schema), if the row is `isolation_mode='dedicated_schema'`, resolve the rest of the block against `dedicated_schema`. `findUserByEmail`, `listRolesForUser`, `listPermissionsForUser`, and `touchLastLogin` then read the tenant's own copies. The DB row is the authority here (no JWT exists at login), which is consistent with "the JWT is the authority *between* logins."
- **Refresh** (`/auth/refresh`): the refresh-token lookup stays tenant-agnostic because the token hash carries no tenant — `refresh_tokens` remains in `public` for **all** tenants as the shared session registry (§3.3 Step 5's single retention). Once the token yields a `tenantId`, the same `{ schema }` scoping applies to `findUserById` and the roles/perms re-resolution.
- **The session registry is schema-qualified, not search_path-dependent:** `insertRefreshToken`, `findRefreshToken`, and `revokeRefreshToken` (`auth.repo.ts:92,106,117`) explicitly reference `public.refresh_tokens` regardless of the active `search_path` — the token registry is platform state, the same way `Db.open` treats `schema_migrations`.
- SSO login shares this flow and inherits the routing.

**Consequence for the JWT:** after re-auth, `isolationMode`/`tenantSchema` claims (§4.2) *and* roles/permissions all come from the tenant's own schema; the access-token path (`/auth/me`, `auth.routes.ts:141`) already runs under `db.tenant` and reads the same copies. One authority, both paths.

---

## 5. Pricing / Plan Gating

**"Dedicated" is an enterprise-tier feature, and the existing billing structures already say how to gate it — with one honest caveat.**

### 5.1 Connection to `subscriptions` / `plan`

- The plan enum is already `trial | core | grow | enterprise` on both `tenants.plan` and `subscriptions.plan`, with `PLAN_SEAT_LIMITS` in `billing.repo.ts`.
- **`dedicated` is not a fifth plan value.** It is a **feature gate attached to the enterprise plan**: the migration endpoint requires `subscriptions.plan = 'enterprise' AND subscriptions.status = 'active'` at preflight time and re-checks at the flip (the row is only readable by the privileged `db.system` path, never through RLS).
- Plan changes remain in the current architecture: `PATCH /billing/subscription/plan` (admin, `billing:write`) records the change in `subscriptions` and audits it. There is no Stripe.

### 5.2 The honest caveat about "enforcement"

The current billing layer **gates by plan value, not by payment**. Any tenant admin can self-upgrade to `enterprise` through the existing plan-change endpoint today — that is the shipped Phase 2 reality (no Stripe, no hard seat-limit enforcement; `seat_limit` is reported, not throttled). Therefore:

- "Only enterprise-tier tenants can request it" is enforced **at the application layer**: migration requires `plan='enterprise'`, subscription `status='active'`, and admin permission. That is real and useful enforcement (a `trial`/`core`/`grow` tenant cannot migrate regardless of who asks).
- What it is **not** is a billing gate (no payment verification). When Stripe/real billing lands (future phase), the same check point — move it into one `assertDedicatedEligible()` helper — becomes a billing-verification check without touching the migration machine. This is the same "feature gate, not payment gate" posture the whole Phase 2 billing module ships with today; the design does not pretend otherwise.

### 5.3 Permission model

| Action | Permission | Who |
|---|---|---|
| View a tenant's isolation/migration status | `tenant:read` | admin |
| Trigger migration / run purge / run rollback | `tenant:write` | admin |

`tenant:read` / `tenant:write` already exist (Phase 5 SSO) and are already admin-only. No new permissions. The migration is **not** exposed to `hr_manager`, `manager`, or `employee` — and it is **not** reachable from any tenant-facing UI; the trigger lives in a platform-administrative surface (admin endpoint + ops script against the same audited function).

### 5.4 Downgrade semantics

A dedicated tenant that later moves to `grow`: the plan downgrade is permitted (existing endpoint), but **dedicated isolation is a contract with the customer, not a consequence of the current plan**. Dedicated stays until an explicit admin reverse-migration. Downgrading plan does not silently unpin tenancy; that is a deliberate, auditable, admin action.

---

## 6. Data Residency — Honest Scope

**Plain language:** real multi-region deployment is **not** in scope for this phase. There is exactly one deployed region. The architecture doc's "region-pinned deployments" (§10) is a stated future capability and `tenants.region` is a placeholder column nothing reads. Building region routing, region-pinned PITR, or an EU-placement planner now would build infrastructure for a capability whose precondition (a second region) does not exist.

**What this phase delivers instead:**

- Schema-per-tenant **isolation**, the Phase 5 roadmap item.
- A **physical container per tenant** (`dedicated_schema`) whose placement is a property of the schema, not of ad-hoc code — this is the mechanism region pinning will later key off (`tenants.dedicated_region` is reserved, NULL, and unused).
- The data-residency *story* a buyer hears: "logical isolation now, physical placement per-region once we deploy additional regions." That is the correct sequence, not the reverse.

**Reframed, per the roadmap:** "data residency options" for Phase 5 = the per-tenant isolated container. "Region pinning" is the follow-on capability and is tracked as a non-goal (§7) until there is a second region to pin to.

---

## 7. Explicit Non-Goals

| Non-goal | Why deferred |
|---|---|
| **Real multi-region deployment / region pinning** | No second region exists. `dedicated_region` reserved but unused. Building placement/routing now is speculative infrastructure. |
| **Self-service / automatic migration** | Migration is risk-bearing enough (identity-boundary-level) that only an admin with `tenant:write` may trigger it, and only after the enterprise gate. **No tenant-facing UI, no auto-upgrade on plan change, no cron** — the migration state machine is only entered through the audited trigger. A plan change to enterprise never auto-migrates; it only makes the trigger available. |
| **DB-per-tenant** | Operational lift (connections, per-DB migrations, per-DB backup) unjustified while one instance + schema-per-tenant covers the requirement. Revisit only with a concrete enterprise/regulated customer or a real second region. |
| **Per-tenant custom backup schedules** | Backups are instance-level (Neon automated snapshots + PITR). Schema-per-tenant inherits that by construction. Per-tenant backup products are a feature with no buyer attached. |
| **Cross-schema reporting/analytics changes** | Reports queries are unqualified and RLS-scoped; routing a dedicated tenant through its schema keeps the existing reports correct (§4.1). **Known gap flagged:** there is no cross-tenant/admin aggregate reporting today — the moment one is built, it must be designed against per-schema routing rather than assumed. That is out of scope here. |
| **Automatic provisioning of dedicated schemas for new signups** | Dedicated is opt-in (existing tenants migrate on demand). New signups stay `shared`; no reason to pay schema cost for a trial tenant. |
| **Downward migration back to shared as self-service** | Rollback to shared is an explicit admin operation with its own state machine record (§8). Not a tenant toggle. |

---

## 8. Audit + Rollback

### 8.1 Every step is audited

The migration is not "a script that ends at cutover." It is a state machine whose **every transition** writes an append-only audit row via the existing `audit()` helper, `actor_type = 'system'`, action namespace `tenant.dedicated_migration.*`:

| State transition | Audit action | Key `after` payload |
|---|---|---|
| Request accepted | `tenant.dedicated_migration.started` | `{tenantId, migrationId, plan, subscriptionStatus}` |
| Schema prepared | `tenant.dedicated_migration.schema_created` | `{migrationId, schemaName, tables: 42, rolePermissionsCopy: true}` |
| Copy complete | `tenant.dedicated_migration.copy_completed` | `{migrationId, manifest_json}` |
| Verify passed | `tenant.dedicated_migration.verified` | `{migrationId, verification_json}` |
| Verify failed | `tenant.dedicated_migration.verify_failed` | `{migrationId, failures[]}` |
| **Flip** | `tenant.dedicated_migration.cutover` | `{migrationId, isolationModeBefore, isolationModeAfter}` |
| **Purge** | `tenant.dedicated_migration.purged` | `{migrationId, tablesPurged: n, rolePermissionsPreserved: true, retainedRefreshTokens: n}` |
| **Rollback** | `tenant.dedicated_migration.rolled_back` | `{migrationId, reason, restoredStatus}` |
| Abort | `tenant.dedicated_migration.aborted` | `{migrationId, reason}` |

**Where the audit rows live — signal this decision explicitly:** module-level audit rows for a tenant live in the schema the tenant was in *at the time of the write* — i.e. pre-flip in `public.audit_logs`, post-flip in the dedicated schema's `audit_logs`. Migration **platform events** (the table above) are deliberately written to `public.audit_logs` regardless of mode: they are platform operations, must be queryable by ops before and after cutover, and RLS already scopes tenant-visible visibility. One consequence to note: a dedicated tenant's module history is split across two `audit_logs` tables at the cutover line. This is correct and documented (it simply mirrors that their data genuinely moved); the `tenant_migrations` table is the continuity index connecting the two.

### 8.2 The abort path (pre-cutover)

Every state before `cutover` is trivially abortable *by never having committed anything destructive*:

- `prepared`/`copying`/`verifying`: DROP the dedicated schema. `public` was never touched. Tenant continues on shared. Audit `aborted`. Idempotent retry with a new migration.
- A verification failure **never** attempts cutover — it is the machine's invariant, not a judgment call.

### 8.3 The rollback path (post-cutover, pre-purge) — the tested one

- Trigger: `POST …/tenants/:id/migrations/rollback` (admin, `tenant:write`).
- Sequence: put tenant in `status='migrating'` (read-only for the tenant, same mechanism as §3.4) → flip `tenants` row back to `isolation_mode='shared'`, `dedicated_schema=NULL` → revoke refresh tokens → DROP the dedicated schema → restore `status='active'`.
- Correctness guarantee: the shared copy is **still fully present** during the entire grace window (purge hasn't run), so this rollback loses nothing and takes seconds.
- Audit `rolled_back` with reason; `tenant_migrations` records it so the platform has a complete migration/return ledger.

### 8.4 The point of no return is purge

After purge there is no in-place rollback; recovery is a reverse migration (copy dedicated → new schema, flip back) that is a normal forward repair, not the rollback path. That is why purge is a **separate, delayed (default 7 days), admin-confirmed step** and never bundled into cutover.

### 8.5 Tested, not assumed

The verification plan (§9) includes an adversarial test that injects a row-count/checksum mismatch and asserts the machine lands in `failed` with the tenant still fully on shared, plus a cutover-then-rollback test asserting row-parity between public and dedicated at every step, plus purge-integrity and purge-safe-login tests proving the cascade cannot destroy a dedicated tenant's role mappings and that re-auth resolves from the tenant's own schema after purge. Rollback is not a happy-path footnote; it is a tested feature.

---

## 9. Verification Plan (post-approval)

| Test | What it proves |
|---|---|
| Migration happy path | Migrate a seeded tenant; assert state machine runs prepared→copied→verified→cutover→(grace)→purged; dedicated schema row parity with public manifest (count + pinned checksum, §3.3 Step 0) at every stage, **including the join-filtered `role_permissions` set**. |
| **Mismatch abort** | Corrupt one checksum (inject a row during verify); assert `failed`, schema dropped, tenant still `shared`, audit rows present, retry succeeds. |
| **Cutover rollback** | Flip, hit `rollback` before purge; assert shared parity restored, schema dropped, tokens revoked, audit `rolled_back`, last-writer-wins data intact. |
| **Purge integrity (role_permissions)** | After purge, per-role mapping sets and counts in `<tn>.role_permissions` are identical to the pre-purge snapshot — proof the `public.roles` cascade (`ON DELETE CASCADE`) destroyed nothing the tenant still depends on. |
| **Purge-safe login** | Post-purge, `/auth/login` + `/auth/refresh` for the dedicated tenant resolve user/roles/perms from the tenant's own schema; fresh JWTs carry full claims; only expired/revoked `public.refresh_tokens` rows were cleaned, active ones retained until TTL. |
| **Self-referential FK copy** | Tenants whose employees have managers and whose departments have parents chain migrate with zero FK anti-join violations; the two `DEFERRABLE` declarations are asserted in the catalog and the golden file. |
| **Quiescence window** | A write to the source during `status='migrating'` is rejected; the manifest snapshot is captured only after the gate takes effect, so manifest/copy/verify/cutover all read the same frozen state. |
| No-cross-tenant | New dedicated tenant + existing tenant both active; cross-query both directions as `app_rls_user` → 0 rows leaked (negative RLS in dedicated schema). |
| Stale-JWT window | Token issued pre-cutover still returns the tenant's own rows pre-purge (never another tenant's); post-purge returns empty until refresh, then routes to dedicated. |
| Reporting on dedicated tenant | `/reports/*` against a dedicated tenant returns identical numbers to pre-migration (RLS-only queries keep working under `search_path` routing). |
| DDL generator | Golden-file diff of the full pipeline (`transformSchema` → `makeSelfRefFksDeferrable` → `rewriteGlobalFkTargets` + the `role_permissions` derivation) blocks any FK-graph drift; no live unqualified `REFERENCES (tenants\|permissions)\s*\(` remains; only the two self-references carry `DEFERRABLE`; plus the subset of check 5 exercised in `dedicated-schema.test.ts` against a throwaway database (catalog assertion over an ephemeral schema) |
| Idempotent retry | Concurrent trigger for the same tenant is rejected; a `failed` run can restart cleanly. |

---

## 10. Summary

| Concern | Decision |
|---|---|
| What "dedicated" means | **Schema-per-tenant** on the existing instance (namespace isolation) — not DB-per-tenant. |
| Why not DB-per-tenant | Same instance/pool/migration/backup machinery, far lower ops lift; instance-level isolation has no customer yet. |
| Connection routing | `SET LOCAL search_path = <dedicated_schema>, public` inside `db.tenant()` for dedicated tenants. `public` second for global tables. |
| RLS in dedicated schema | **Kept and FORCEd** with the identical `current_setting('app.current_tenant')` policy — defense in depth, belt and suspenders, exactly the arch doc's posture. |
| How the app knows the mode | JWT claims (`isolationMode`, `tenantSchema`), projected at `authenticate()`, consistent with the "SET LOCAL comes from the JWT" discipline. |
| Migration | Copy (42 tables + a join-filtered `role_permissions` copy; parents-before-children; self-ref FKs deferred) → Verify (manifest count+checksum, FK anti-joins incl. self-edges, `role_permissions` parity, negative-RLS) → atomic flip → **delayed** purge (7-day grace). Source-of-truth principle: shared schema is never mutated until cutover. |
| Traffic during migration | **State-based read-only** (`status='migrating'`) from the manifest snapshot through the flip — the source is quiescent *before* any ground truth is taken, so manifest/copy/verify/cutover all read one frozen state; restored to full read+write once the flip is confirmed (§3.4). |
| Rollback | Tested path pre-cutover (drop schema) and post-cutover pre-purge (flip back + drop; shared copy intact). Purge = declared point of no return. |
| **Purge safety** | `role_permissions` is copied per-tenant (`role_id → <tn>.roles`), so the `public.roles` cascade is non-destructive; a post-purge integrity check re-asserts per-role mapping parity; login/refresh resolve roles/perms from the tenant's own schema (§4.5), and only expired/revoked `public.refresh_tokens` rows are purged (active tokens = transient session registry). |
| Plan gate | Enterprise `plan` + `status='active'` required by `assertDedicatedEligible()` at preflight and flip. Dedicated is a feature gate on enterprise, not a fifth plan. |
| Enforcement honesty | Gating is application-layer (plan + permission + status). No payment gate until Stripe lands — same posture as Phase 2 billing today. |
| Data residency | Isolation is the deliverable; **region pinning explicitly deferred** until a second region exists. `dedicated_region` reserved, unused. |
| Non-goals | Multi-region, self-service migration, DB-per-tenant, per-tenant backup schedules, reporting/analytics changes, auto-provisioning of dedicated schemas. |
| Audit | Every state transition written to `audit_logs` (`system`, `tenant.dedicated_migration.*`); platform migration events always in `public.audit_logs`. |
| New tables | `tenant_migrations` (global state machine, no RLS policy) + 2 `tenants` columns (`isolation_mode`, `dedicated_schema`) + reserved `dedicated_region`. |
| Resolved: hardenRls parameterization | `hardenRls(exec, schema = 'public')` + `isHardeningApplied(exec, schema = 'public')` with `assertSchemaName` guard; **11 existing call sites unchanged**, 1 new call in `materializeDedicatedSchema`. |
| Resolved: DDL generation | Dedicated tables materialized from the **same canonical phase sources** (`transformSchema`) → `makeSelfRefFksDeferrable()` (self-ref FKs only) → `rewriteGlobalFkTargets()` (identifier-boundary, allowlist-only), executed with `search_path = <tn>, public`, plus the derived `<tn>.role_permissions`; proven by golden-file CI diff **and** a migration-time `pg_constraint` catalog assertion. |
| New infra | None. No new connection strings, no new instances, no new backup products. |

---

**Stop point reached — design doc complete, awaiting review before any implementation.**