# Phase 4 — Benefits Administration Module Design

**Status:** Draft for review  
**Date:** 2026-09-22  
**Scope:** Benefit plans, enrollment periods, employee elections, life-event changes, carrier integration stub

---

## 1. Data Model

### Reads from: `employees` (existing, Phase 0/1)

Same pattern as Payroll and Performance. Benefits reads `employees.employment_type`, `employees.employment_status`, and `employees.hire_date` for eligibility. No duplication.

### Design decision: Dependents get their own table now

Dependents (spouse, children) need a dedicated `benefit_dependents` table in this phase, not deferred. Reasoning:

- Benefit elections are fundamentally _per-person_ — a family medical plan's cost depends on whether the employee covers a spouse, one child, or multiple children. Without dependents, the enrollment record can't express what was actually elected.
- Dependents are the most common source of life-event changes (birth, marriage, divorce). If dependents live in `custom_fields` JSONB, life-event processing has no structured data to act on.
- The `employees` table has no columns for marital status or dependents, and adding them would mix benefits-specific PII into a core HR table. A separate table keeps benefits data isolated and auditable.
- Dependents are small in volume (typically <10 per employee) and only need name, relationship, date of birth, and SSN (encrypted). The table is simple.

### New tables

#### `benefit_plans`

```sql
CREATE TABLE benefit_plans (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    name                TEXT NOT NULL,
    description         TEXT,
    plan_type           TEXT NOT NULL,         -- medical | dental | vision | life_insurance | retirement | hsa | fsa | other
    carrier_name        TEXT,                  -- e.g. 'Blue Cross', 'Delta Dental'
    coverage_tiers      TEXT[] NOT NULL DEFAULT '{}',  -- e.g. {'employee_only','employee_spouse','employee_child','family'}
    employer_contribution_pct NUMERIC(5,2),    -- e.g. 70.00 = employer pays 70%
    employee_cost      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {"employee_only": 250.00, "family": 800.00} monthly premiums per tier
    is_active          BOOLEAN NOT NULL DEFAULT true,
    created_by         UUID REFERENCES user_accounts(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_plan_type CHECK (plan_type IN ('medical', 'dental', 'vision', 'life_insurance', 'retirement', 'hsa', 'fsa', 'other'))
);

ALTER TABLE benefit_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE benefit_plans FORCE ROW LEVEL SECURITY;
```

#### `enrollment_periods`

```sql
CREATE TABLE enrollment_periods (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            TEXT NOT NULL,             -- e.g. 'Q4 2026 Open Enrollment'
    description     TEXT,
    period_type     TEXT NOT NULL DEFAULT 'open_enrollment',  -- open_enrollment | life_event
    status          TEXT NOT NULL DEFAULT 'draft',  -- draft | active | closed | finalized
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL,
    coverage_starts DATE,                     -- when elected coverage takes effect
    created_by      UUID REFERENCES user_accounts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_period_type CHECK (period_type IN ('open_enrollment', 'life_event')),
    CONSTRAINT valid_enrollment_status CHECK (status IN ('draft', 'active', 'closed', 'finalized')),
    CONSTRAINT valid_enrollment_dates CHECK (starts_at < ends_at)
);

ALTER TABLE enrollment_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_periods FORCE ROW LEVEL SECURITY;
```

#### `benefit_enrollments`

```sql
CREATE TABLE benefit_enrollments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    employee_id         UUID NOT NULL REFERENCES employees(id),
    enrollment_period_id UUID NOT NULL REFERENCES enrollment_periods(id),
    benefit_plan_id     UUID NOT NULL REFERENCES benefit_plans(id),
    coverage_tier       TEXT NOT NULL,         -- 'employee_only' | 'employee_spouse' | 'employee_child' | 'family'
    employee_premium    NUMERIC(10,2) NOT NULL,  -- employee's monthly cost after employer contribution
    employer_premium    NUMERIC(10,2) NOT NULL,  -- employer's monthly contribution
    status              TEXT NOT NULL DEFAULT 'draft',  -- draft | submitted | confirmed | withdrawn
    submitted_at        TIMESTAMPTZ,
    confirmed_at        TIMESTAMPTZ,           -- carrier has confirmed enrollment
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
```

#### `benefit_dependents`

```sql
CREATE TABLE benefit_dependents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    first_name      TEXT NOT NULL,
    last_name       TEXT NOT NULL,
    relationship    TEXT NOT NULL,             -- spouse | child | domestic_partner
    date_of_birth   DATE,
    ssn_enc         TEXT,                      -- encrypted, for carrier submission
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_relationship CHECK (relationship IN ('spouse', 'child', 'domestic_partner'))
);

ALTER TABLE benefit_dependents ENABLE ROW LEVEL SECURITY;
ALTER TABLE benefit_dependents FORCE ROW LEVEL SECURITY;
```

#### `enrollment_dependents` (join table: which dependents are covered by which enrollment)

```sql
CREATE TABLE enrollment_dependents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    enrollment_id       UUID NOT NULL REFERENCES benefit_enrollments(id) ON DELETE CASCADE,
    dependent_id        UUID NOT NULL REFERENCES benefit_dependents(id) ON DELETE CASCADE,

    CONSTRAINT unique_enrollment_dependent UNIQUE (enrollment_id, dependent_id)
);

ALTER TABLE enrollment_dependents ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_dependents FORCE ROW LEVEL SECURITY;
```

#### `life_events`

```sql
CREATE TABLE life_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    employee_id         UUID NOT NULL REFERENCES employees(id),
    event_type          TEXT NOT NULL,         -- marriage | birth | divorce | death | adoption | loss_of_other_coverage | gain_of_other_coverage
    event_date          DATE NOT NULL,
    description         TEXT,
    status              TEXT NOT NULL DEFAULT 'reported',  -- reported | acknowledged | enrollment_window_opened
    enrollment_period_id UUID REFERENCES enrollment_periods(id),  -- the special window opened for this event
    reported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_by     UUID REFERENCES user_accounts(id),
    acknowledged_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_life_event_type CHECK (event_type IN ('marriage', 'birth', 'divorce', 'death', 'adoption', 'loss_of_other_coverage', 'gain_of_other_coverage')),
    CONSTRAINT valid_life_event_status CHECK (status IN ('reported', 'acknowledged', 'enrollment_window_opened'))
);

ALTER TABLE life_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE life_events FORCE ROW LEVEL SECURITY;
```

---

## 2. Permission Model — Manager Visibility Excluded

### Decision: No manager visibility on benefits data

Benefits data is excluded from manager visibility entirely. Managers cannot see anything in this module — not their own reports' enrollments, not their plans, not their dependents. Only the employee themselves, admin, and hr_manager have access.

**Reasoning:**

- Benefits elections reveal information employees haven't disclosed elsewhere: dependents (marital status, children), health plan tier choices (family vs. individual implies household composition), and life insurance beneficiary patterns. This is categorically more sensitive than payroll (which reveals salary) or performance (which reveals assessment).
- Payroll and performance both scoped managers to direct reports because managers have a legitimate operational need (managing compensation, conducting reviews). Managers have no operational need to see benefits data. They don't approve benefits, they don't manage carrier relationships, and they don't need to know whether a direct report covers a spouse.
- The privacy case is stronger than HIPAA compliance — even if the system isn't a covered entity, the _norm_ is that benefits data is HR-confidential. Employees expect it. Violating that expectation erodes trust in the platform.
- Admin and hr_manager already have full access (they handle benefits administration). The employee sees their own data. That's the complete access model.

### Scoping rules (explicit)

| Entity | Who can read | Who can write | Enforcement |
|--------|-------------|---------------|-------------|
| **benefit_plans** | Admin, hr_manager only | Admin, hr_manager only | Route permission: `BENEFITS_WRITE`. No employee or manager access. Plans are tenant-wide configuration, not per-employee data. |
| **enrollment_periods** | Admin, hr_manager only | Admin, hr_manager only | Same as plans. Periods are tenant-wide configuration. |
| **benefit_enrollments** | Employee (own), admin, hr_manager | Employee (create own draft/submit own), admin, hr_manager | Repository filter: `employee_id = req.ctx.employeeId` OR role = admin/hr_manager. Manager scope: **none**. |
| **benefit_dependents** | Employee (own), admin, hr_manager | Employee (manage own), admin, hr_manager | Same as enrollments. |
| **enrollment_dependents** | Derives from enrollment visibility | Employee (own enrollment), admin, hr_manager | Derives from parent enrollment access. |
| **life_events** | Employee (own), admin, hr_manager | Employee (report own), admin, hr_manager (acknowledge) | Same as enrollments. |

### New permissions

```typescript
// Added to PERMISSIONS in permissions.ts
BENEFITS_READ: 'benefits:read',
BENEFITS_WRITE: 'benefits:write',
```

### Role assignment

| Role | Permissions |
|------|------------|
| admin | `benefits:read`, `benefits:write` |
| hr_manager | `benefits:read`, `benefits:write` |
| manager | _(none)_ — managers have zero access to benefits data |
| employee | `benefits:read`, `benefits:write` (own enrollments/dependents/life-events only, scoped at route level) |

Note: Employee `benefits:write` is scoped to their own data at the route level — the permission gates access, the repository filter enforces ownership.

---

## 3. Enrollment Window Enforcement

### State machine

```
draft → active → closed → finalized
```

| Status | Meaning | Who can trigger | Action |
|--------|---------|----------------|--------|
| `draft` | Period created, dates set, plans assigned | Admin, hr_manager | Create the period, set start/end dates, link eligible benefit_plans |
| `active` | Window open for employee selections | Admin, hr_manager | Employees can create/modify/withdraw enrollments |
| `closed` | Deadline passed or manually closed | Admin, hr_manager | No more employee changes allowed |
| `finalized` | Enrollments confirmed with carrier | Admin, hr_manager | Sets confirmed_at on all submitted enrollments. Read-only. |

Transitions are forward-only. Follows the performance review_cycles transition map pattern.

### Enrollment rules (enforced in route handlers)

1. **No enrollment outside an open window:** If no `enrollment_periods` row exists with `status = 'active'` AND `starts_at <= now() <= ends_at`, employee enrollment writes are rejected. There is no "always open" mode.

2. **One enrollment per plan per period:** The `UNIQUE (employee_id, enrollment_period_id, benefit_plan_id)` constraint on `benefit_enrollments` prevents duplicate elections. An employee can enroll in multiple plans (medical + dental + vision) within one period, but not two medical plans.

3. **Life events as the exception path:** A life event (marriage, birth, etc.) creates a new `enrollment_periods` row with `period_type = 'life_event'` scoped to that employee only. This period has a short window (typically 30 days from the event date). The employee can enroll/change elections only within this personal window. The flow:
   - Employee reports a life event → `life_events` row created with `status = 'reported'`
   - Admin/hr_manager acknowledges the event → `status = 'acknowledged'`
   - Admin/hr_manager opens a life-event enrollment window → new `enrollment_periods` row with `period_type = 'life_event'`, linked via `life_events.enrollment_period_id`
   - Employee enrolls within the window → `benefit_enrollments` row created
   - Window closes → `status = 'closed'`

4. **Withdrawal during active window:** An employee can withdraw a `submitted` enrollment while the period is still `active`. Withdrawn enrollments set `withdrawn_at` and update `status = 'withdrawn'`. Once the period is `closed` or `finalized`, no changes are allowed.

### Carrier integration stub

This phase records enrollments in the system but does not transmit them to any carrier. The enrollment lifecycle (draft → submitted → confirmed) is internal. The `confirmed` status is manually set by admin/hr_manager, not by carrier callback.

---

## 4. Carrier Integration — Stub Interface

Following the Payroll TaxEngine pattern exactly.

```typescript
// backend/src/modules/benefits/carrier-engine.ts

export interface CarrierEnrollmentInput {
  tenantId: string
  employeeId: string
  planName: string
  planType: string
  coverageTier: string
  employeePremium: number
  employerPremium: number
  dependents: Array<{
    firstName: string
    lastName: string
    relationship: string
    dateOfBirth: string
  }>
}

export interface CarrierEnrollmentOutput {
  /** Whether this enrollment was actually transmitted to a carrier. */
  transmitted: boolean
  /** Carrier reference ID (if transmitted). */
  carrierReferenceId: string | null
  /** Human-readable status message. */
  message: string
}

export interface CarrierEngine {
  transmitEnrollment(input: CarrierEnrollmentInput): CarrierEnrollmentOutput
  withdrawEnrollment(carrierReferenceId: string): CarrierEnrollmentOutput
}

/**
 * Stub/demo carrier engine. Does not transmit anything.
 * Returns transmitted: false to signal this is NOT real carrier integration.
 */
export class StubCarrierEngine implements CarrierEngine {
  transmitEnrollment(input: CarrierEnrollmentInput): CarrierEnrollmentOutput {
    return {
      transmitted: false,
      carrierReferenceId: null,
      message: 'Stub engine: enrollment recorded in system only. Connect a real carrier integration to transmit enrollments.',
    }
  }

  withdrawEnrollment(carrierReferenceId: string): CarrierEnrollmentOutput {
    return {
      transmitted: false,
      carrierReferenceId: null,
      message: 'Stub engine: withdrawal recorded in system only.',
    }
  }
}
```

The stub returns `transmitted: false` — the same pattern as TaxEngine's `compliant: false`. A real carrier integration (EDI 834 generation, carrier API, or benefits admin vendor like Benefitfocus or naturally) plugs in behind `CarrierEngine` without changing the enrollment logic.

---

## 5. Relationship to Payroll — Flagged, Not Built

Benefit elections typically become payroll deductions. The integration point is explicit and already documented:

- `payslips.deductions` JSONB column (phase4-payroll.sql, line 45) — the Payroll design doc's non-goals table states: *"Benefits module doesn't exist yet. When it does, it plugs in as a deduction source in the `payslip.deductions` JSONB array."*
- The shape is `{ name: string; amount: number }` per TaxDeduction. A benefit deduction entry would look like: `{ "name": "Medical — Blue Cross PPO", "amount": 250.00 }`.
- A future integration would read `benefit_enrollments` for active employees, compute the employee premium, and inject it as a deduction during payroll calculation. The `benefit_plans.employee_cost` JSONB provides the premium lookup by coverage tier.
- This is explicitly **not wired up** in this phase. The data model supports it; the connection is a future concern.

---

## 6. Audit + RLS

### Audit

Reuses the existing `audit_logs` table and the `audit()` helper. No new parallel systems.

**Actions logged:**

| Action | When | `entity_type` | `before_state` | `after_state` |
|--------|------|---------------|----------------|---------------|
| `benefits.plan.created` | Plan created | `benefit_plan` | null | Full plan object |
| `benefits.plan.updated` | Plan edited | `benefit_plan` | Previous state | Updated state |
| `benefits.period.created` | Enrollment period created | `enrollment_period` | null | Full period object |
| `benefits.period.status` | Period status changed | `enrollment_period` | Previous status | New status |
| `benefits.enrollment.created` | Employee creates enrollment | `benefit_enrollment` | null | Full enrollment object |
| `benefits.enrollment.submitted` | Employee submits enrollment | `benefit_enrollment` | Previous state | `{ status: 'submitted', submitted_at }` |
| `benefits.enrollment.confirmed` | Admin confirms enrollment | `benefit_enrollment` | Previous state | `{ status: 'confirmed', confirmed_at }` |
| `benefits.enrollment.withdrawn` | Employee withdraws enrollment | `benefit_enrollment` | Previous state | `{ status: 'withdrawn', withdrawn_at }` |
| `benefits.dependent.created` | Dependent added | `benefit_dependent` | null | Full dependent object |
| `benefits.dependent.updated` | Dependent edited | `benefit_dependent` | Previous state | Updated state |
| `benefits.dependent.deactivated` | Dependent deactivated | `benefit_dependent` | `{ is_active: true }` | `{ is_active: false }` |
| `benefits.life_event.reported` | Employee reports life event | `life_event` | null | Full event object |
| `benefits.life_event.acknowledged` | Admin acknowledges event | `life_event` | Previous state | `{ status: 'acknowledged' }` |

Actor type: `'user'` for all benefits operations.

### RLS

New tables added to `TENANT_SCOPED_TABLES` in `backend/src/db/schema.ts`. The `hardenRls()` pass applies the standard `tenant_isolation` policy.

---

## 7. Explicit Non-Goals for This Phase

| Non-goal | Why deferred |
|----------|-------------|
| Real carrier transmission (EDI 834, carrier APIs) | The stub interface is the integration point. A real carrier connection (EDI file generation, API integration, or benefits admin vendor) plugs in behind `CarrierEngine` when needed. |
| Cost calculation / proration engine | Employee premiums are manually entered on the enrollment. A calculation engine that derives premiums from plan configuration, salary, and coverage tier is a future enhancement. |
| COBRA / compliance-specific workflows | COBRA has its own enrollment window, notification requirements, and premium calculation rules. That's a dedicated feature, not a subset of standard enrollment. |
| Manager visibility | By design (§2). Managers have zero access to benefits data. No exceptions this phase. |
| Automated life-event verification | Life events are self-reported and take effect on entry. A document upload / approval workflow (marriage certificate, birth certificate) is a future concern. |
| Benefits reporting / analytics | Reporting module exists separately. Benefits data feeds into reports via the same query pattern as other modules. No dedicated benefits analytics engine this phase. |
| Retroactive enrollment changes | Changes take effect prospectively from the enrollment period's `coverage_starts` date. Retroactive premium adjustments or coverage backdates are deferred. |
| Multi-carrier plan comparison / recommendation | No decision-support tooling. Plans are listed; employees choose. Recommendation logic is a future AI module concern. |
| HSA/FSA contribution management | The plan types exist in the schema, but contribution tracking (annual limits, catch-up contributions, qualified expenses) is a separate feature. This phase only records the election. |

---

## 8. File Structure (Proposed)

```
phase4-benefits.sql                      -- Migration: all new tables
backend/src/modules/benefits/
  benefits.repo.ts                       -- Query helpers (plans, periods, enrollments, dependents, life events)
  benefits.routes.ts                     -- API endpoints
  carrier-engine.ts                      -- CarrierEngine interface + stub implementation
```

Plus updates to:
- `backend/src/db/schema.ts` — add table names to `TENANT_SCOPED_TABLES`, add `applyBenefitsSchema()`
- `backend/src/db/index.ts` — add migration entry
- `backend/src/modules/permissions.ts` — add `BENEFITS_READ`, `BENEFITS_WRITE`
- `backend/src/http/app.ts` — register benefits routes

---

## 9. API Endpoints

| Method | Path | Permission | Who can call | What they see |
|--------|------|------------|-------------|---------------|
| `GET` | `/benefits/plans` | `benefits:read` | admin, hr_manager | All active plans in the tenant |
| `POST` | `/benefits/plans` | `benefits:write` | admin, hr_manager | Create a benefit plan |
| `PATCH` | `/benefits/plans/:id` | `benefits:write` | admin, hr_manager | Edit plan details |
| `GET` | `/benefits/periods` | `benefits:read` | admin, hr_manager | All enrollment periods |
| `POST` | `/benefits/periods` | `benefits:write` | admin, hr_manager | Create an enrollment period |
| `POST` | `/benefits/periods/:id/status` | `benefits:write` | admin, hr_manager | Transition period status |
| `GET` | `/benefits/enrollments` | `benefits:read` | admin, hr_manager | All enrollments in tenant |
| `POST` | `/benefits/enrollments` | `benefits:write` | admin, hr_manager, employee | Create enrollment (employee: own only) |
| `POST` | `/benefits/enrollments/:id/submit` | `benefits:write` | employee (own), admin, hr_manager | Submit enrollment |
| `POST` | `/benefits/enrollments/:id/confirm` | `benefits:write` | admin, hr_manager | Confirm enrollment with carrier |
| `POST` | `/benefits/enrollments/:id/withdraw` | `benefits:write` | employee (own), admin, hr_manager | Withdraw enrollment |
| `GET` | `/benefits/dependents` | `benefits:read` | admin, hr_manager | All dependents in tenant |
| `POST` | `/benefits/dependents` | `benefits:write` | admin, hr_manager, employee | Add dependent (employee: own only) |
| `PATCH` | `/benefits/dependents/:id` | `benefits:write` | employee (own), admin, hr_manager | Edit dependent |
| `POST` | `/benefits/dependents/:id/deactivate` | `benefits:write` | employee (own), admin, hr_manager | Deactivate dependent (sets `is_active = false`). Used for life events like divorce. Dependent is not deleted — historical enrollment records may reference them. |
| `GET` | `/benefits/life-events` | `benefits:read` | admin, hr_manager | All life events in tenant |
| `POST` | `/benefits/life-events` | `benefits:write` | admin, hr_manager, employee | Report life event (employee: own only) |
| `POST` | `/benefits/life-events/:id/acknowledge` | `benefits:write` | admin, hr_manager | Acknowledge life event |
| `GET` | `/benefits/my-elections` | _(none — JWT only)_ | any authenticated employee | Own enrollments, dependents, life events |

---

## 10. Open Questions for Review

1. **Plan cost JSONB shape:** `benefit_plans.employee_cost` is currently `{ "employee_only": 250.00, "family": 800.00 }`. Should this be a structured JSONB with more fields (e.g., `{ "tier": "employee_only", "monthly_premium": 250.00, "annual_premium": 3000.00 }`) or keep it flat? Recommendation: flat map — simpler for UI rendering, and the premium period (monthly) can be a plan-level attribute rather than per-tier.

2. **Life event enrollment window duration:** Should the system enforce a maximum window duration (e.g., 30 days from event date), or leave it to admin discretion? Recommendation: admin-configurable per life event, with a suggested default of 30 days. The `enrollment_periods` row has explicit `starts_at`/`ends_at` dates — the admin sets the window when they acknowledge the event.

3. **Enrollment confirmation scope:** When admin "confirms" an enrollment, should it confirm all pending enrollments for that period at once, or one-by-one? Recommendation: one-by-one — different plans may have different carrier confirmation timelines. Batch confirmation can be a UI convenience that calls the endpoint in a loop.

4. **Dependent age-out:** Should the system track when a dependent ages out of coverage (e.g., child turns 26 for US medical plans)? Recommendation: not this phase. The `date_of_birth` column is stored; age-out logic is a future compliance feature. Admin handles it manually for now.

5. **Multiple enrollment periods:** Can an employee have concurrent active enrollment periods (e.g., annual open enrollment + a life event window)? Recommendation: yes — the employee can have active enrollments in both. The `UNIQUE (employee_id, enrollment_period_id, benefit_plan_id)` constraint is scoped per period, so concurrent periods can each independently hold an enrollment for the same plan with no DB-level conflict. **Concurrent-period conflicts are not resolved automatically this phase.** If an employee enrolls in the same plan through both an open enrollment period and a life-event window, both enrollment rows will exist. Admin/hr_manager must manually reconcile (withdraw the older enrollment, or confirm both and let the carrier sort it out). A future phase could add auto-withdrawal logic (confirming an enrollment in one period auto-withdraws conflicting draft/submitted enrollments for the same plan in other active periods for that employee), but that is explicitly deferred.

---

## Tracked Issue: Neon Pooler Connection Refusals

**Status:** Cause unconfirmed, currently masked by retries. Does not block this work.

**What happens:** Intermittent connection failures when the test suite or migration connects to Neon Postgres via the pooler. The pool config (`max: 16`, `connectionTimeoutMillis: 10_000`) is well within Neon's limits, and test files run sequentially (no concurrent pool competition).

**What it is NOT:** Not pool exhaustion — each suite opens its own 16-connection pool, and Vitest runs test files sequentially. The `connectionTimeoutMillis: 10_000` means a pooler refusal surfaces as a timeout, not necessarily a clear "connection refused" error.

**Hypothesis:** Neon's pooler intermittently becomes slow or unavailable (transient infrastructure issue), causing the 10-second connection timeout to fire. This is masked in practice because retries eventually succeed.

**Evidence needed:** Timing data across multiple test runs to correlate failures with load patterns or time-of-day. Currently unavailable.

**Action:** Keep this note visible. If the issue recurs or worsens, investigate Neon pooler logs and connection timing rather than assuming it's external noise.

**Tracked follow-up (2026-09-23):** The e2e suite (`e2e.test.ts`) now exceeds a 300s bash timeout due to accumulated Phase 2–4 setup overhead in `beforeAll` (schema migrations, `resetDemoLeaveState` cleanup, integration hub seed). The warm-up and connection succeed — this is a suite-duration problem, not a connectivity problem. Needs either a longer CI timeout or suite splitting. Deferred as its own follow-up, not blocking.
