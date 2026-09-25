# Phase 4 — Performance Management Module Design

**Status:** Draft for review  
**Date:** 2026-09-22  
**Scope:** Goal setting (OKR/KPI), continuous feedback, review cycles, performance reviews, minimal calibration

---

## 1. Data Model

### Reads from: `employees` (existing, Phase 0/1)

Same pattern as Payroll. The module reads `employees.manager_employee_id` for org hierarchy (direct-report scoping). No duplication.

### Design decision: Goals persist independently across cycles

Goals are **not** children of a review cycle. A goal belongs to an employee and optionally maps to a cycle when the employee or their manager chooses to include it in a review. Reasoning:

- OKR/KPI goals have their own lifecycle (set quarterly, but some are ongoing). Forcing them under a cycle creates an artificial parent-child that doesn't match how people set goals.
- A cycle is a _snapshot window_ — it collects whatever goals are active at that time and asks "how did we do?" It does not _own_ the goals.
- This matches the UI concept: the progress ring shows "Q3 goals" but the individual goals have their own due dates and categories, not a cycle FK.
- When a cycle closes, goals that were mapped to it retain their progress. They don't reset — they continue into the next cycle if still active.

### New tables

#### `goals`

```sql
CREATE TABLE goals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),
    title           TEXT NOT NULL,
    description     TEXT,
    category        TEXT,                     -- e.g. 'design', 'growth', 'cross-team'
    goal_type       TEXT NOT NULL DEFAULT 'okr',  -- okr | kpi | custom
    target_value    NUMERIC(10,2),            -- for KPI: numeric target
    current_value   NUMERIC(10,2) DEFAULT 0, -- for KPI: current progress
    percentage      INT DEFAULT 0,            -- for OKR: manual or computed percentage
    status          TEXT NOT NULL DEFAULT 'active',  -- active | completed | abandoned
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
```

#### `review_cycles`

```sql
CREATE TABLE review_cycles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            TEXT NOT NULL,             -- e.g. 'Q3 2026'
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'draft',  -- draft | active | collecting | calibration | finalized
    starts_at       DATE NOT NULL,
    ends_at         DATE NOT NULL,
    review_deadline DATE,                      -- when self+manager reviews are due
    finalized_by    UUID REFERENCES user_accounts(id),
    finalized_at    TIMESTAMPTZ,
    created_by      UUID REFERENCES user_accounts(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_cycle_status CHECK (status IN ('draft', 'active', 'collecting', 'calibration', 'finalized')),
    CONSTRAINT valid_cycle_dates CHECK (starts_at < ends_at)
);

ALTER TABLE review_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_cycles FORCE ROW LEVEL SECURITY;
```

#### `cycle_goals` (join table: which goals map to which cycle)

```sql
CREATE TABLE cycle_goals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    cycle_id        UUID NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
    goal_id         UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    mapped_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_cycle_goal UNIQUE (cycle_id, goal_id)
);

ALTER TABLE cycle_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cycle_goals FORCE ROW LEVEL SECURITY;
```

#### `performance_reviews` (one per employee per cycle)

```sql
CREATE TABLE performance_reviews (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    cycle_id        UUID NOT NULL REFERENCES review_cycles(id),
    employee_id     UUID NOT NULL REFERENCES employees(id),

    -- Self review
    self_rating     INT,                      -- 1-5 scale
    self_comment    TEXT,
    self_submitted_at TIMESTAMPTZ,

    -- Manager review
    manager_id      UUID REFERENCES employees(id),  -- the reviewer
    manager_rating  INT,
    manager_comment TEXT,
    manager_submitted_at TIMESTAMPTZ,

    -- Final rating (set during calibration or by HRBP)
    final_rating    INT,
    finalized_by    UUID REFERENCES user_accounts(id),
    finalized_at    TIMESTAMPTZ,

    status          TEXT NOT NULL DEFAULT 'draft',  -- draft | self_submitted | manager_reviewing | calibration | finalized
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_review_status CHECK (status IN ('draft', 'self_submitted', 'manager_reviewing', 'calibration', 'finalized')),
    CONSTRAINT valid_rating CHECK (final_rating IS NULL OR (final_rating >= 1 AND final_rating <= 5)),
    CONSTRAINT unique_employee_cycle UNIQUE (cycle_id, employee_id)
);

ALTER TABLE performance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_reviews FORCE ROW LEVEL SECURITY;
```

#### `feedback_entries` (continuous feedback, outside formal cycles)

```sql
CREATE TABLE feedback_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    author_id       UUID NOT NULL REFERENCES employees(id),
    recipient_id    UUID NOT NULL REFERENCES employees(id),
    cycle_id        UUID REFERENCES review_cycles(id),  -- null = ad-hoc, not tied to a cycle
    content         TEXT NOT NULL,
    feedback_type   TEXT NOT NULL DEFAULT 'general',  -- general | kudos | coaching | peer
    is_anonymous    BOOLEAN NOT NULL DEFAULT false,   -- true = author hidden from recipient (see §2 decision)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_feedback_type CHECK (feedback_type IN ('general', 'kudos', 'coaching', 'peer'))
);

ALTER TABLE feedback_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_entries FORCE ROW LEVEL SECURITY;
```

---

## 2. Permission Model — Row-Level Scoping (Designed Up Front)

### Decision: Admin/hr_manager bypass is checked first

Same pattern as Payroll. The condition will be:

```typescript
if (req.ctx.roles.includes('manager') && !req.ctx.roles.includes('admin') && !req.ctx.roles.includes('hr_manager')) {
  // scope to direct reports only
}
```

This ensures an admin who also carries `manager` is never incorrectly restricted.

### Scoping rules (explicit)

| Entity | Who can read | Who can write | Enforcement |
|--------|-------------|---------------|-------------|
| **goals** | Owner, direct manager, admin, hr_manager | Owner (status/title/description), admin, hr_manager | Repository filter: `employee_id = current_user` OR `manager_employee_id = current_user_employee_id` OR role = admin/hr_manager |
| **review_cycles** | All authenticated users (cycles are tenant-wide, not per-employee) | Admin, hr_manager only | Route permission: `PERFORMANCE_WRITE` |
| **performance_reviews** | The employee being reviewed, their direct manager, admin, hr_manager | Self-review: employee. Manager review: manager. Finalize: admin, hr_manager | Repository filter on `employee_id` + `manager_id` |
| **feedback_entries** | Author, recipient, admin, hr_manager | Author (create only — no edits this phase), admin | Repository filter on `author_id` / `recipient_id` |
| **cycle_goals** | Anyone who can see the goal or the cycle | Admin, hr_manager, or the goal owner when mapping their own goals | Derives from goal + cycle visibility |

### Self-review visibility — explicit decision

**Question:** Can an employee see a manager's draft notes before the review is finalized?

**Answer: No.** The `manager_comment` and `manager_rating` fields on `performance_reviews` are hidden from the employee until `status = 'finalized'`. Before finalization, the employee sees only their own `self_*` fields and the cycle status. After finalization, the employee sees `final_rating` and `manager_comment`. This is enforced at the route level — the response payload excludes `manager_*` fields when the caller is the review subject and the review is not yet finalized.

Rationale: Draft manager notes are working materials. Premature disclosure undermines honest assessment. If the organization wants open calibration, that's a post-finalization review discussion, not real-time draft sharing.

### New permissions

```typescript
// Added to PERMISSIONS in permissions.ts
PERFORMANCE_READ: 'performance:read',
PERFORMANCE_WRITE: 'performance:write',
PERFORMANCE_APPROVE: 'performance:approve',
```

### Role assignment

| Role | Permissions |
|------|------------|
| admin | `performance:read`, `performance:write`, `performance:approve` |
| hr_manager | `performance:read`, `performance:write`, `performance:approve` |
| manager | `performance:read`, `performance:write` |
| employee | `performance:read`, `performance:write` (own goals, own self-review, own feedback only) |

Note: Employee `performance:write` is scoped to their own data at the route level — the permission gates access, the repository filter enforces ownership.

---

## 3. Calibration Workflow — Scoped for This Phase

### What calibration means

Managers and HRBPs review ratings across a team to ensure consistency — e.g., "Manager A rated their team generously while Manager B was harsh; should we normalize?"

### This phase: minimal calibration (locked/finalized state + HRBP override)

| Feature | In scope | Not in scope (deferred) |
|---------|----------|------------------------|
| Cycle status: `calibration` → `finalized` | Yes | — |
| HRBP can override `final_rating` on any review in the cycle | Yes | — |
| Calibration view: list of all reviews in a cycle grouped by manager, with rating distribution | No (defer to next phase) | — |
| Rating normalization / forced curve | No | — |
| Calibration session UI (side-by-side comparison) | No | — |
| Audit trail of who changed what rating during calibration | Yes (audit_logs) | — |

The `calibration` status on `review_cycles` is a gate: when a cycle is in `calibration`, managers can no longer submit or edit their reviews. Only HRBPs (admin/hr_manager) can finalize ratings. The transition from `collecting` → `calibration` is triggered by the admin when all manager reviews are submitted (or the deadline passes).

---

## 4. Review Cycle Lifecycle

```
draft → active → collecting → calibration → finalized
```

| Status | Meaning | Who can trigger | Action |
|--------|---------|----------------|--------|
| `draft` | Cycle created, goals being mapped | Admin, hr_manager | Create the cycle, set dates, map goals via `cycle_goals` |
| `active` | Cycle is open for goal setting | Admin, hr_manager, employee | Employees can create/edit goals and map them to the cycle |
| `collecting` | Goal setting closed, self+manager reviews in progress | Admin, hr_manager | Employees submit self-reviews; managers submit manager reviews |
| `calibration` | Reviews collected, HRBP reviewing for consistency | Admin, hr_manager | Managers locked out; HRBPs can adjust `final_rating` |
| `finalized` | Cycle complete, ratings locked | Admin, hr_manager | Sets `finalized_by`, `finalized_at`. All reviews become read-only. |

Transitions are forward-only within a cycle. A finalized cycle cannot be reopened.

---

## 5. Relationship to Existing Modules

| Module | How Performance reads from it | Shared infrastructure |
|--------|------------------------------|----------------------|
| **Employees** | `employees.id`, `employees.manager_employee_id` for org hierarchy | Same RLS/TENANT_SCOPED_TABLES pattern |
| **Auth/Users** | `user_accounts.id` for `created_by`, `finalized_by`, `approved_by` | Same JWT context (`req.ctx`) |
| **Audit** | All writes logged to `audit_logs` via `audit()` helper | Existing `audit()` function from `backend/src/lib/audit.ts` |
| **Payroll** | None — no data flow between modules in this phase | Future integration point (see §6) |

No new parallel systems. The module follows the same `db.tenant()` → `Q` → repository pattern as every other module.

---

## 6. Audit + RLS

### Audit

Reuses the existing `audit_logs` table and the `audit()` helper. No new parallel systems.

**Actions logged:**

| Action | When | `entity_type` | `before_state` | `after_state` |
|--------|------|---------------|----------------|---------------|
| `performance.goal.created` | Goal created | `goal` | null | Full goal object |
| `performance.goal.updated` | Goal edited | `goal` | Previous state | Updated state |
| `performance.goal.completed` | Goal marked complete | `goal` | Previous state | `{ status: 'completed', completed_at }` |
| `performance.cycle.created` | Cycle created | `review_cycle` | null | Full cycle object |
| `performance.cycle.status` | Cycle status changed | `review_cycle` | Previous status | New status |
| `performance.review.submitted` | Self or manager review submitted | `performance_review` | Previous state | Updated state |
| `performance.review.finalized` | Rating finalized | `performance_review` | Previous state | `{ final_rating, finalized_by, finalized_at }` |
| `performance.feedback.created` | Feedback entry created | `feedback_entry` | null | Full entry |

### RLS

New tables added to `TENANT_SCOPED_TABLES` in `backend/src/db/schema.ts`. The `hardenRls()` pass applies the standard `tenant_isolation` policy.

---

## 7. Explicit Non-Goals for This Phase

| Non-goal | Why deferred |
|----------|-------------|
| AI-assisted review writing | That's Phase 3 / AI Agent territory. The AI module provides coaching prompts; it does not draft performance reviews. |
| Compensation-linked review outcomes | Connecting ratings to raises/bonuses would touch Payroll. Flag as a future integration point — when Payroll adds a `performance_review_id` column to compensation adjustments — but don't build it now. |
| Anonymous peer feedback | **Out of scope for this phase.** Peer feedback is attributed (author_id visible to recipient and admin/hr_manager). Anonymous feedback requires a separate anonymity layer (blind author, escrow for abuse review) that adds meaningful complexity. If the organization needs it, that's a dedicated follow-up. |
| Multi-level / skip-level reviews | Reviews are single-hop: employee → direct manager. Skip-level reviews require recursive org traversal and a more complex review assignment model. Defer. |
| 360° reviews (multiple raters per employee) | The schema supports self + manager only. A full 360° model (peer nominations, multi-rater feedback aggregation) is a significant expansion. The `feedback_entries` table captures continuous peer input, but formal multi-rater review scoring is deferred. |
| Calibration UI / rating distribution analytics | The calibration workflow is backend-only (locked state + HRBP override). A visual calibration dashboard with distribution charts is a frontend concern for a later phase. |
| Goal cascading (parent → child goals across org levels) | Goals are individual. Organization-level or department-level goal trees with automatic decomposition are deferred. |
| Historical trend analysis / dashboards | Reporting module exists separately. Performance data feeds into reports via the same query pattern as other modules — no dedicated analytics engine in this phase. |
| Performance improvement plans (PIPs) | PIPs have their own lifecycle (goals, milestones, deadlines, escalation). That's a future module or a sub-feature of this one, not in scope now. |

---

## 8. File Structure (Proposed)

```
phase4-performance.sql                    -- Migration: all new tables
backend/src/modules/performance/
  performance.repo.ts                     -- Query helpers (goals, cycles, reviews, feedback)
  performance.routes.ts                   -- API endpoints
```

Plus updates to:
- `backend/src/db/schema.ts` — add table names to `TENANT_SCOPED_TABLES`, add `applyPerformanceSchema()`
- `backend/src/db/index.ts` — add migration entry
- `backend/src/modules/permissions.ts` — add `PERFORMANCE_READ`, `PERFORMANCE_WRITE`, `PERFORMANCE_APPROVE`

---

## 9. API Endpoints

| Method | Path | Permission | Who can call | What they see |
|--------|------|------------|-------------|---------------|
| `GET` | `/performance/goals` | `performance:read` | admin, hr_manager, manager, employee | Own goals (employee), direct reports' goals (manager), all (admin/hr_manager) |
| `POST` | `/performance/goals` | `performance:write` | admin, hr_manager, employee | Create a goal. `employee_id` defaults to self unless admin/hr_manager specifies another. |
| `PATCH` | `/performance/goals/:id` | `performance:write` | goal owner, admin, hr_manager | Edit goal title/description/percentage/status |
| `GET` | `/performance/cycles` | `performance:read` | admin, hr_manager, manager, employee | All cycles in tenant (cycles are tenant-wide) |
| `POST` | `/performance/cycles` | `performance:write` | admin, hr_manager | Create a review cycle |
| `POST` | `/performance/cycles/:id/status` | `performance:write` | admin, hr_manager | Transition cycle status |
| `POST` | `/performance/cycles/:id/goals` | `performance:write` | admin, hr_manager, employee | Map a goal to a cycle |
| `GET` | `/performance/reviews` | `performance:read` | admin, hr_manager, manager | All reviews in tenant (filtered by cycle). Manager sees direct reports only. |
| `GET` | `/performance/reviews/:id` | `performance:read` | admin, hr_manager, manager, employee (own only) | Single review. Employee sees only self_* fields unless finalized. |
| `POST` | `/performance/reviews/:id/self` | `performance:write` | employee (own review only) | Submit self-review. Transitions status to `self_submitted`. |
| `POST` | `/performance/reviews/:id/manager` | `performance:write` | direct manager, admin, hr_manager | Submit manager review. Transitions status to `manager_reviewing`. |
| `POST` | `/performance/reviews/:id/finalize` | `performance:approve` | admin, hr_manager | Set final_rating. Transitions status to `finalized`. |
| `GET` | `/performance/feedback` | `performance:read` | admin, hr_manager, manager, employee | Own feedback (sent + received). Manager sees direct reports' feedback. |
| `POST` | `/performance/feedback` | `performance:write` | admin, hr_manager, manager, employee | Create feedback entry. `author_id` = self. |
| `GET` | `/performance/me` | _(none — JWT only)_ | any authenticated employee | Own goals + own reviews + own feedback. Self-service endpoint. |

---

## 10. Open Questions for Review

1. **Goal percentage vs. target_value:** Should the API accept both `percentage` (manual OKR) and `target_value/current_value` (computed KPI) simultaneously, or should these be mutually exclusive based on `goal_type`? Recommendation: mutually exclusive — `okr` uses `percentage`, `kpi` uses `target_value`/`current_value`, `custom` uses `percentage`.

2. **Feedback anonymous flag:** The `is_anonymous` column exists on `feedback_entries` but anonymous feedback is listed as a non-goal. Should we keep the column (ready for future use) or remove it to avoid confusion? Recommendation: keep it, but the route handler ignores it — all feedback is attributed in this phase. The column is schema-ready for when anonymous support is added.

3. **Cycle goal mapping limit:** Should there be a max number of goals an employee can map to a single cycle? Recommendation: no hard limit at the DB level. Let the UI enforce a soft limit (e.g., 5-7 goals) if desired.

4. **Manager review without self-review:** Can a manager submit their review before the employee submits their self-review? Recommendation: yes — the statuses are independent. The manager might have enough context to review without waiting. The cycle's `review_deadline` is the forcing function, not the self-review submission.
