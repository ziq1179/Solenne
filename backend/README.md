# Trellis HRMS API — Phase 0/1

Backend for the Trellis HRMS SaaS platform: tenancy, auth/IAM, core HR, leave,
attendance, and audit. Fastify 5 + TypeScript (ESM) on top of `pg` connection
pools (indexed by tenant-role), with per-request **Row-Level-Security** tenant
isolation enforced inside PostgreSQL itself.

## Runtime facts (verified — not aspirational)

| Fact | Value |
| --- | --- |
| Database | **PostgreSQL 18.6** on **Neon** (`neondb` database) |
| Connection | Pooled transactions via the Neon pooler (`-pooler.c-7.us-east-2.aws.neon.tech`, `type: transaction`) |
| Driver | `pg` (`pg.Pool`), pool size **16** (env `PGPOOL_MAX`) |
| TLS | **On + CA-verified by default** (`ssl: true` → `verify-full`). `DB_SSL=lenient` = encrypted but unverified; `DB_SSL=false` only for trusted networks — never silently downgraded |
| ID generation | `uuidv7()`-style app ids + `gen_random_uuid()` (PG13+) for DB defaults |
| RLS enforcement | **15 tenant-scoped tables**, `FORCE ROW LEVEL SECURITY`, owned by non-superuser `app_rls_user`; append-only `audit_logs` |
| Target era | Schema is **PostgreSQL 13+ / 16-class**; nothing newer is usedvb differences all verified against the live 18.6 server |
| Bootstrap | Superuser (`neondb_owner`) is a **member** of `app_rls_user` (so `SET LOCAL ROLE` works for migrations); membership verified by probe |

**The 15 tenant-scoped tables** (canonical `phase0-1-schema.sql` + one extra):

- Core tenancy/auth: `user_accounts`, `roles`, `user_roles`, `refresh_tokens`
- HR: `departments`, `locations`, `employees`, `employment_history`, `compensation_records`
- Leave/attendance: `leave_types`, `leave_balances`, `leave_requests`, `attendance_records`
- Append-only: `audit_logs`
- API contract: `idempotency_keys` — the Idempotency-Key replay store required
  by the API contract. **Not in the canonical SQL** — added by the backend's
  `EXTRA_DDL` in `src/db/schema.ts`. It is tenant-scoped, RLS-policy'd, and
  included in the hardening loop (count goes 14 → 15).

Global lookup tables (`tenants`, `permissions`, `role_permissions`) are owned by
the bootstrap user and granted only `SELECT`/`USAGE` to `app_rls_user`.

## Quickstart

```bash
# from backend/
pnpm install
cp .env.example .env        # edit DATABASE_URL + JWT_SECRET
pnpm db:init                # apply schema + RLS hardening (idempotent)
pnpm db:seed                # idempotent demo seed (Acme + Globex tenants)
pnpm dev                    # http://localhost:4000
```

**Demo sign-ins** (also printed on every `pnpm db:seed`):

| Tenant | Email | Password | Role |
| --- | --- | --- | --- |
| acme | `admin@acme.com` | `admin123` | admin |
| acme | `priya@acme.com` | `manager123` | manager (ReportsTo: admin) |
| acme | `aisha@acme.com` | `employee123` | employee (ReportsTo: manager) |
| globex | `admin@globex.com` | `admin123` | admin |

## Test suite

```bash
pnpm test   # 13 e2e tests against DATABASE_URL (Neon). ~82s cold, re-runnable.
```

Covers: login/JWT/refresh-rotation, idempotent `POST /employees` (replay of the
same Idempotency-Key returns the stored 201, not a duplicate), `POST /leave`
submit + `PATCH /leave/:id` approve (balance arithmetic), tenure-history trail,
employee offboarding, manager/self permission guards, cross-tenant 404s
(employee isolation), and a **12-way `Promise.all` RLS isolation burst**
(6 Acme + 6 Globex concurrent queries — every one stays within its own tenant).

The suite mutates leave requests/approvals, so it calls
`resetDemoLeaveState(db)` in `beforeAll` to restore the demo baseline before
each run — which is why it's safe to re-run against the same Neon database.

**Windows notes**

- Node 24 + the Neon pooler: set `NODE_OPTIONS=--dns-result-order=ipv4first`
  before `pnpm test` / `pnpm dev` to avoid IPv6 DNS hangs.
- Use `pnpm.cmd` (not `pnpm.ps1`) inside `Start-Process`/subshells.

## Security model

All tenant-scoped tables carry:

- a `tenant_id` column,
- **`FORCE ROW LEVEL SECURITY`**, and
- a composite policy (`tenant_isolation`) conditioned on
  `current_setting('app.current_tenant', true)::uuid` — set per-request from the
  JWT claim by the pool's `options` hook, so each pooled checkout lands in the
  right tenant.
- Ownership: `OWNER TO app_rls_user` (the app role), *not* the bootstrap user.

The app connects as a **non-superuser** (`app_rls_user`), sits behind RLS on
every tenant table, and reads global lookup tables through narrow `SELECT`. The
bootstrap superuser only appears in migrations.

### Migrations / hardening (`src/db/schema.ts`)

- `applyBaseSchema()` — applies `phase0-1-schema.sql` transform to drop
  `CREATE EXTENSION` and swap `uuid_generate_v4()` → `gen_random_uuid()`.
- `hardenRls()` — idempotent: enforces owners, policies, `FORCE`,
  `REVOKE UPDATE, DELETE ON audit_logs` (append-only), and global-table
  `SELECT` grants. Safe to re-run (verified: no-op on an already-hardened DB).
- Both run through a **single pooled checkout** so `SET LOCAL ROLE` membership
  is visible to the same transaction (verified empirically).

### Migration/admin rules (learned the hard way, on Neon)

- The bootstrap role must be **granted membership** in `app_rls_user` **before**
  `ALTER ... OWNER TO app_rls_user` — otherwise "must be able to SET ROLE".
- Ownership transfer requires the target role to already hold `USAGE` + `CREATE`
  on the schema.
- Policy DDL (`CREATE POLICY` / `DROP POLICY`) must run **as the owner**
  (`SET LOCAL ROLE app_rls_user`), verified empirically — re-owning tables
  breaks policy drop/create otherwise.
- Always migrate as the bootstrap/system role, **never** as `app_rls_user`
  through a tenant query; re-running `hardenRls()` is the supported repair path.
