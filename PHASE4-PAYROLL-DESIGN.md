# Phase 4 — Payroll Module Design

**Status:** Approved for implementation  
**Date:** 2026-09-21  
**Scope:** Payroll runs, payslips, synthetic tax model, compliance stub interface

---

## 1. Country / Tax Scope Decision

### Proposal: Option C — Deferred to a compliance vendor integration point

**Chosen approach:** A stub `TaxEngine` interface now, with a synthetic/demo calculator as the default implementation. Real tax logic lives behind that interface, plugged in later per jurisdiction.

**Why not the other options:**

| Option | Rejected because |
|--------|-----------------|
| A: Single-country flat-rate model | Even a "simplified" flat rate implies a real jurisdiction. If the flat rate is 20%, that's not any real country's rate. Labeling it as non-compliance-grade doesn't prevent misuse — someone will put a real employee in it. |
| B: Synthetic/demo fixed percentages | Same problem with a different name. The moment the UI shows "Tax: −$1,050.20" on a payslip, it looks real. The concept mockup already has that line. We'd be building a visual lie into the product. |
| **C: Stub interface + synthetic default** | The synthetic calculator produces plausible demo numbers for screenshots and testing, but the code makes it impossible to mistake for real compliance. A future compliance integration (ADP, Remote, Deel, or a local provider) drops in behind the same interface without changing the payroll run logic. |

**What the stub interface looks like:**

```typescript
export interface TaxEngine {
  calculate(input: TaxInput): TaxOutput
}

export interface TaxInput {
  tenantCountry: string        // ISO 3166-1 alpha-2
  employeeCountry: string
  grossPay: number
  payFrequency: 'monthly' | 'biweekly' | 'weekly'
  taxYear: number
}

export interface TaxOutput {
  /** Breakdown of deductions, e.g. [{ name: 'Federal income tax', amount: 1200 }, ...] */
  deductions: Array<{ name: string; amount: number }>
  totalDeductions: number
  /** Whether this engine can legally produce payslips for this jurisdiction. */
  compliant: boolean
}
```

The synthetic implementation returns `compliant: false` and uses fixed percentages (e.g. 15% federal, 7.65% FICA — US-flavored for demo purposes only). A future real engine returns `compliant: true` when connected to an actual tax provider.

The `compliant` flag is informational, not enforced — the system doesn't block payroll runs when it's false. But the UI can display a badge: "Demo mode — not compliance-grade."

---

## 2. Data Model

### Reads from: `compensation_records` (existing, Phase 0/1)

The payroll run reads `compensation_records` for each employee's current base salary, pay frequency, and currency. No duplication. The `compensation_records` table already has:
- `employee_id`, `effective_date` (versioned), `base_salary_amount`, `currency`, `pay_frequency`
- RLS + tenant-scoping (in `TENANT_SCOPED_TABLES`)
- Append-only semantics (no UPDATE/DELETE grants)

### New tables

#### `payroll_runs`

```sql
CREATE TABLE payroll_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft',  -- draft | calculated | approved | paid
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
```

#### `payslips`

```sql
CREATE TABLE payslips (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    payroll_run_id  UUID NOT NULL REFERENCES payroll_runs(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    compensation_record_id UUID NOT NULL REFERENCES compensation_records(id),

    -- Earnings
    base_pay        NUMERIC(14,2) NOT NULL,
    overtime_pay    NUMERIC(14,2) NOT NULL DEFAULT 0,
    bonus           NUMERIC(14,2) NOT NULL DEFAULT 0,
    other_earnings  NUMERIC(14,2) NOT NULL DEFAULT 0,
    gross_pay       NUMERIC(14,2) NOT NULL,

    -- Deductions (broken out per the engine's output)
    deductions      JSONB NOT NULL DEFAULT '[]'::jsonb,
    total_deductions NUMERIC(14,2) NOT NULL DEFAULT 0,

    -- Net
    net_pay         NUMERIC(14,2) NOT NULL,

    -- Metadata
    currency        TEXT NOT NULL DEFAULT 'USD',
    tax_compliant   BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Immutable: no UPDATE or DELETE at the application level.
    -- Corrections create a new payslip with a different id in a new payroll_run.
    CONSTRAINT valid_net CHECK (net_pay = gross_pay - total_deductions)
);

ALTER TABLE payslips ENABLE ROW LEVEL SECURITY;
ALTER TABLE payslips FORCE ROW LEVEL SECURITY;
```

### Immutability rule

Payslips are immutable once their parent `payroll_run` leaves `draft` status. The application code never UPDATEs or DELETEs a payslip row. Corrections produce a new `payslip` in a new `payroll_run` whose `correction_of` column references the original run.

This matches the principle already applied to `compensation_records` and the audit_logs table.

---

## 3. Payroll Run Lifecycle

```
draft → calculated → approved → paid
```

| Status | Meaning | Who can trigger | Permission | Action |
|--------|---------|----------------|------------|--------|
| `draft` | Run created, no payslips generated yet | HR Manager, Admin | `payroll:write` | Create the run (period dates, currency). Fetches `compensation_records` for all active employees in the tenant. |
| `calculated` | Payslips generated, tax engine applied, totals computed | HR Manager, Admin | `payroll:write` | Triggers calculation: for each active employee with a current `compensation_record`, compute base pay for the period, apply the tax engine, generate the `payslip` row, aggregate `total_gross`/`total_net`/`total_deductions`/`employee_count` on the run. |
| `approved` | Payroll run reviewed and locked | Admin only | `payroll:approve` | Sets `approved_by`, `approved_at`. Prevents further edits to the run or its payslips. |
| `paid` | Disbursement completed | Admin only | `payroll:write` | Sets `paid_at`. In this phase, this is a status flag only — no bank file generation (see non-goals). |

**Transitions are one-way.** You cannot move from `approved` back to `calculated`. If a mistake is found after approval, the admin creates a new corrective `payroll_run` referencing the same period.

### New permissions

```typescript
// Added to PERMISSIONS in permissions.ts
PAYROLL_READ: 'payroll:read',
PAYROLL_WRITE: 'payroll:write',
PAYROLL_APPROVE: 'payroll:approve',
```

### Role assignment

| Role | Permissions |
|------|------------|
| admin | `payroll:read`, `payroll:write`, `payroll:approve` |
| hr_manager | `payroll:read`, `payroll:write` |
| manager | `payroll:read` |
| employee | _(none)_ — employees access own payslips via `/payroll/my-payslips` using JWT identity, not a permission |

---

## 4. Relationship to Billing — Explicit Separation

**Billing** (Phase 2) is what the tenant pays the SaaS vendor for the subscription. It has `invoices`, `subscriptions`, `usage_events`, `payment_methods`. Its currency is the tenant's billing currency. Its `tenant_id` scopes which customer account is being billed.

**Payroll** (Phase 4) is what employees receive as compensation from the tenant. It has `payroll_runs`, `payslips`, and reads from `compensation_records`. Its currency is the employee's pay currency (usually the tenant's local currency). Its `tenant_id` scopes which employer's payroll is being processed.

**They share no tables, no routes, and no schemas.** The only commonality is the tenant-scoping pattern and the audit_logs table. Both modules use `tenant_id` as the isolation boundary, but the data they store is entirely distinct.

A future integration where payroll costs feed into billing (e.g., employer-side benefit charges) would be a new endpoint or job, not a reuse of existing billing tables.

---

## 5. Explicit Non-Goals for This Phase

| Non-goal | Why deferred |
|----------|-------------|
| Bank/disbursement file generation (ACH, SEPA, etc.) | Requires real banking integration, format spec compliance, and client-specific configuration. Defer to when a real customer needs it. |
| Multi-country tax engine | The stub interface is the integration point. A real engine (ADP, Remote, Deel, or local provider) plugs in behind `TaxEngine` when needed. |
| Benefits deductions integration | Benefits module doesn't exist yet. When it does, it plugs in as a deduction source in the `payslip.deductions` JSONB array. |
| Payslip PDF generation | Returns structured JSON. PDF rendering is a presentation concern — can be added later without changing the data model. |
| Retroactive pay adjustments | Complex edge case (back-pay, correction of historical periods). Defer until a real use case requires it. |
| Multi-currency conversion within a single payroll run | Each run has one `currency`. Cross-currency scenarios (e.g., employee paid in EUR, company in USD) are a future concern. |
| Employee self-service payslip portal | Employees can read their own payslips via API. A dedicated UI page is a frontend concern, not in this phase's scope. |

---

## 6. Audit + RLS

### Audit

Reuses the existing `audit_logs` table and the `audit()` helper from `backend/src/lib/audit.ts`. No new parallel systems.

**Actions logged:**

| Action | When | `entity_type` | `before_state` | `after_state` |
|--------|------|---------------|----------------|---------------|
| `payroll.run.created` | Draft run created | `payroll_run` | null | Full run object |
| `payroll.run.calculated` | Payslips generated | `payroll_run` | Previous state | Updated state + payslip IDs |
| `payroll.run.approved` | Admin approves | `payroll_run` | Previous state | `{ approved_by, approved_at }` |
| `payroll.run.paid` | Marked as paid | `payroll_run` | Previous state | `{ paid_at }` |
| `payslip.created` | Individual payslip generated | `payslip` | null | Full payslip object |

Actor type: `'user'` for all payroll operations. The `actor_id` is the authenticated user's ID.

### RLS

New tables are added to `TENANT_SCOPED_TABLES` in `backend/src/db/schema.ts`. The `hardenRls()` pass applies:
- `tenant_isolation` policy (USING + WITH CHECK on `tenant_id`)
- `ENABLE ROW LEVEL SECURITY`
- `FORCE ROW LEVEL SECURITY`

**Self-service filter for payslips:** Employees access their own payslips via `/payroll/my-payslips`, which uses the JWT's `employeeId` claim to filter — no `payroll:read` permission involved. This endpoint is gated by `authenticate` only (any logged-in user), and the route handler filters `WHERE employee_id = req.ctx.employeeId`. HR/manager endpoints (`/payroll/runs`, `/payroll/runs/:id/payslips`, `/payroll/payslips/:id`) require `payroll:read` and see all payslips in the tenant.

---

## 7. API Endpoints

| Method | Path | Permission | Who can call | What they see |
|--------|------|------------|-------------|---------------|
| `GET` | `/payroll/runs` | `payroll:read` | admin, hr_manager, manager | All runs in the tenant. Status filter optional. |
| `POST` | `/payroll/runs` | `payroll:write` | admin, hr_manager | Creates a draft run. `created_by` set to current user. |
| `POST` | `/payroll/runs/:id/calculate` | `payroll:write` | admin, hr_manager | Transitions draft → calculated. Generates payslips for all active employees with current `compensation_record`. |
| `POST` | `/payroll/runs/:id/approve` | `payroll:approve` | admin only | Transitions calculated → approved. Sets `approved_by` and `approved_at`. Locks the run. |
| `POST` | `/payroll/runs/:id/pay` | `payroll:write` | admin, hr_manager | Transitions approved → paid. Sets `paid_at`. Status flag only (no bank file). |
| `GET` | `/payroll/runs/:id/payslips` | `payroll:read` | admin, hr_manager, manager | All payslips in the run. |
| `GET` | `/payroll/payslips/:id` | `payroll:read` | admin, hr_manager, manager | Single payslip by ID. |
| `GET` | `/payroll/my-payslips` | _(none — JWT only)_ | any authenticated user | Own payslips only (`employee_id = req.ctx.employeeId`). Self-service, no permission check beyond login. |

---

## 8. Seed Data

No demo compensation data exists yet (the `compensation_records` table is schema-only). Phase 4 will seed:
- 5–10 `compensation_records` for existing demo employees
- 1 completed `payroll_run` (status: `paid`) with payslips for all seeded employees
- 1 in-progress `payroll_run` (status: `draft`) for the current month

This gives the UI something to render and the API something to return without requiring manual data entry.

---

## 9. File Structure (Proposed)

```
phase4-payroll.sql                    -- Migration: payroll_runs + payslips tables
backend/src/modules/payroll/
  payroll.repo.ts                     -- Query helpers (list runs, get payslips, etc.)
  payroll.routes.ts                   -- API endpoints
  tax-engine.ts                       -- TaxEngine interface + synthetic implementation
```

---

## 10. Open Questions for Review

1. **Payslip deductions JSONB shape:** Should the deductions array have a fixed schema (`{ name, amount, category }`) or remain fully freeform? Fixed schema is safer for UI rendering; freeform is more flexible for future deduction types.

2. **Period uniqueness constraint:** `UNIQUE (tenant_id, period_start, period_end)` prevents duplicate runs for the same month. Is this too restrictive? What if a tenant runs payroll twice in a month for different employee groups? (Recommendation: keep the constraint, handle groups via a future `employee_group` column on the run if needed.)

3. **Overtime and bonus calculation:** These columns exist on the payslip but aren't computed by the synthetic tax engine. Should the `calculate` endpoint accept an optional adjustments payload, or should these be left as manual overrides?
