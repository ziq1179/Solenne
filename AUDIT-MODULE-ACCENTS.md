# Meridian ESS — Module Accent Deep Audit

**Date:** 2026-09-21
**Scope:** All screens built through items 2 and 3
**Purpose:** Class-by-class verification that every module's accent tokens are applied correctly against the design concept's logic

---

## Accent Token Registry

| Token | Hex | Module | Source |
|---|---|---|---|
| `brass` | `#B08D57` | Core HR | Concept §1 |
| `teal` | `#2F6F6F` | Recruitment | Concept §2 |
| `wine` | `#7A3B46` | Leave & Attendance | Concept §3 |
| `forest` | `#2F5338` | Payroll | Concept §4 (reserved, not yet built) |
| `plum` | `#5B3C6F` | Reports / Performance | Concept §5 + user decision |
| `cobalt` | `#3B5C8C` | ESS / Self-Service (Dashboard) | Concept §6 |
| `bronze` | `#8B7355` | Billing | Proposed 7th token — pending approval |

Each token has four variants: base, `-soft` (lighter + desaturated, for hover/secondary), `-tint` (near-white, for card backgrounds), `-ink` (dark, for text on tint backgrounds).

---

## 1. Login (Brass Gate)

**Route:** `/login`
**Accent:** Brass (brand identity of the entry point)

The concept file never designed an auth screen. Brass is the foundational brand accent of "Solenne ESS" — it's the color of the logo mark, the "ESS" suffix in the wordmark, and the Core HR module it represents. Using it at the entry point is a deliberate choice: the login screen IS the face of the product.

### Class-by-class

| Element | Classes | Token | Assessment |
|---|---|---|---|
| Page background | `grid min-h-screen place-items-center bg-paper px-4` | Paper | Correct — warm off-white, Meridian base |
| Logo SVG | `h-7 w-7 text-brass` | Brass | Correct — brand icon |
| Wordmark | `font-display text-xl text-ink` + `text-brass` on "ESS" | Ink + brass | Correct — matches concept brand treatment |
| Form card | `rounded-2xl border border-line bg-paper p-6` | Neutral | Correct — subtle container, not module-specific |
| Labels | `mb-1 block text-xs font-medium uppercase tracking-wide text-graphite-soft` | Graphite soft | Correct — standard label treatment |
| Inputs | `border-line bg-paper focus:border-brass focus:outline-none` | Brass focus ring | Correct — brass as the global interactive accent |
| Submit button | `bg-brass text-paper hover:bg-brass-soft w-full` | Brass | Correct — primary CTA in brand color |
| "Create a workspace" link | `text-brass hover:underline` | Brass | Correct — secondary navigation in brand color |
| Demo text | `text-graphite-soft`, code blocks `text-graphite-faint` | Graphite | Correct — subtle helper text |

**Verdict:** Clean. Brass is applied consistently as the brand identity color across all interactive and branding elements.

---

## 2. Signup (Brass Gate — converted from dark theme)

**Route:** `/signup`
**Accent:** Brass (brand identity, matching login)

Originally rendered with a dark slate theme (`bg-slate-950`, `text-sky-400`, `border-slate-800`). Converted to Meridian light theme to match login.

### Class-by-class (post-fix)

| Element | Classes | Token | Assessment |
|---|---|---|---|
| Page background | `bg-paper` | Paper | Correct — matches login |
| Logo SVG | `text-brass` | Brass | Correct — matches login |
| Wordmark | `font-display text-xl text-ink` + `text-brass` | Ink + brass | Correct — matches login |
| Form card | `border-line bg-paper p-6` | Neutral | Correct — matches login |
| Inputs | `focus:border-brass` | Brass focus ring | Correct — shared Input component |
| Submit button | `bg-brass text-paper hover:bg-brass-soft` | Brass | Correct — matches login |
| "Sign in" link | `text-brass hover:underline` | Brass | Correct — matches login's "Create a workspace" |
| Footer text | `text-graphite-soft` | Graphite soft | Correct — matches login hierarchy |

**Verdict:** Clean. Signup is now a mirror of login — same brass-gate treatment, same hierarchy. No old slate/sky classes remain (verified via server-rendered HTML grep).

---

## 3. Dashboard (Cobalt — ESS/Self-Service)

**Route:** `/dashboard`
**Accent:** Cobalt (per concept §6)

The concept assigns cobalt to ESS with the rationale: "close to the corporate ink but lighter, so it still feels like the same company, just a calmer room in it." The concept's ESS design uses cobalt-tint action tiles with solid cobalt icon backgrounds.

### Class-by-class

| Element | Classes | Token | Concept reference |
|---|---|---|---|
| Page `h1` | `text-2xl font-semibold` | Neutral ink | Correct — concept uses neutral headings for ESS |
| **BalancesCard "Remaining"** | `font-medium text-cobalt` | Cobalt | **§6:** The "remaining days" is the key personal metric — cobalt makes it the focal number, matching the concept's emphasis on quick-action data |
| **Request list items** | `bg-cobalt-tint px-3 py-2` | Cobalt-tint bg | **§6:** Concept's `.ess-tile { background: var(--cobalt-tint) }` — action-adjacent items get the tinted treatment |
| **Request icon** | `h-4 w-4 text-cobalt` | Cobalt | **§6:** Concept's `.ess-tile .ic { background: var(--cobalt) }` — icons in the cobalt system |
| **Request text** | `text-sm text-cobalt-ink` | Cobalt ink | Text on cobalt-tint background uses cobalt-ink for contrast |
| Clock card | Neutral `Card` + `Badge tone="green"/"slate"` | Neutral + semantic | Correct — clock-in/out is functional, not a highlight element |
| History card | Neutral table with `text-slate-*` | Neutral slate | Correct — attendance history is data, not accent |
| Timestamps | `text-slate-400` | Slate neutral | Correct — tertiary information |

**Verdict:** Clean. Cobalt is applied to the elements the concept designates as cobalt (action tiles, balance highlights) while keeping functional elements neutral.

---

## 4. Leave (Wine — Leave & Attendance)

**Route:** `/leave`
**Accent:** Wine (per concept §3)

The concept assigns wine to Leave with the rationale: "Wine gives the module warmth without reading as an alert color — leave requests are routine, not urgent." The concept's design uses wine-tint balance cards and wine-colored calendar highlights.

### Class-by-class

| Element | Classes | Token | Concept reference |
|---|---|---|---|
| Page `h1` | `text-2xl font-semibold` | Neutral ink | Correct — heading is neutral |
| Request form card | Neutral `Card` | Neutral | Correct — the form is a workspace, not a display element |
| **"My requests" list items** | `rounded-lg bg-wine-tint px-3 py-2` | Wine-tint bg | **§3:** Concept's `.balance-card { background: var(--wine-tint) }` — the wine-tint treatment for leave-related cards |
| **Request name** | `text-sm font-medium text-wine-ink` | Wine ink | Text on wine-tint uses wine-ink for readability |
| **Detail text** | `text-xs text-wine-soft` | Wine soft | Secondary text in the wine system — muted but still wine-family |
| **"No requests yet"** | `text-sm text-wine-soft` | Wine soft | Empty state stays in the wine family |
| Status badges | `Badge tone="green"/"amber"/"red"/"slate"` | Semantic | Correct — approval status is semantic, not module-specific |

**Verdict:** Clean. Wine is applied to the request list (the "leave" content), while the form workspace stays neutral.

---

## 5. Reports (Plum — analytical)

**Route:** `/reports`
**Accent:** Plum (user decision — Reports is analytical, closer to Performance's spirit than Payroll's forest)

The concept assigns forest specifically to Payroll. Reports is the analytical counterpart — headcount breakdowns, attendance summaries, leave balances. Plum's analytical character (concept §5: "reflective rather than clinical, fitting a conversation about growth") fits naturally.

### Class-by-class

| Element | Classes | Token | Concept reference |
|---|---|---|---|
| **Page `h1`** | `text-2xl font-semibold text-plum` | Plum | Module accent on heading — same pattern as other modules |
| **Stat card** | `className="border-plum-tint"` | Plum-tint border | Subtle module identity on the key metric card |
| **All CardTitles** | `className="text-plum-soft"` | Plum soft | Section headers in muted plum — **§5:** concept's `.goal-pct { color: var(--plum) }` adapted to section labels |
| **Table header rows** | `text-plum-soft` on `<tr>` | Plum soft | Column labels in plum — consistent with CardTitle treatment |
| Table data rows | `text-slate-*` | Neutral slate | Data is always neutral — correct |
| Alerts | `tone="sky"` / `tone="amber"` | Semantic | Informational alerts use standard tones — correct |

**Verdict:** Clean. Plum creates a distinct analytical identity without conflicting with Payroll's forest.

---

## 6. Notifications (Neutral with cobalt attention)

**Route:** `/notifications`
**Accent:** None (cross-cutting) — cobalt used for attention/interaction signals

Notifications is a feed of activity across all modules. It has no module-specific identity of its own. The concept file has no notifications design.

### Class-by-class

| Element | Classes | Token | Rationale |
|---|---|---|---|
| Page `h1` | `text-2xl font-semibold` | Neutral ink | Correct — no module accent for cross-cutting features |
| Unread badge | `Badge tone="sky"` → `bg-cobalt-tint text-cobalt` | Cobalt | Cobalt as "active/attention" signal — same logic as ESS dashboard tiles |
| "Mark all read" btn | `Button variant="ghost"` | Neutral ghost | Secondary action, shouldn't compete with content |
| Empty state icon | `BellOff h-8 w-8 text-graphite-faint` | Graphite faint | Correct — subdued empty state |
| Empty state text | `text-sm text-graphite-soft` | Graphite soft | Correct — matches other empty states |
| List wrapper | `Card` + `divide-y divide-line` | Neutral | Standard card treatment |
| **Unread item bg** | `bg-cobalt-tint/30` | Cobalt at 30% opacity | **No concept precedent.** Rationale: cobalt-tint is the ESS "workspace" color — unread items are things you need to act on, same mental model as dashboard action tiles. 30% opacity keeps it subtle for a full list. |
| **Read item** | `opacity-60` | CSS opacity | Visual de-emphasis without changing the color system |
| **Unread bell icon** | `text-cobalt` | Cobalt | Matches the unread tint — consistent attention color |
| **Read bell icon** | `text-graphite-faint` | Graphite faint | Recedes into background |
| Title text | `text-sm font-medium text-ink` | Ink | Primary content is always ink |
| Type badge | Semantic tones (`green`/`amber`/`red`/`sky`/`slate`) | Module-agnostic | **Correct:** badges describe *what happened*, not *which module*. "Leave approved" is green because it's positive, not because it's wine-tinted. |
| Body text | `text-sm text-graphite-soft` | Graphite soft | Secondary text |
| Timestamp | `text-xs text-graphite-faint` | Graphite faint | Tertiary text |
| "Mark read" link | `text-xs text-cobalt hover:underline` | Cobalt | Matches the cobalt attention system |

**Verdict:** Clean. The cobalt-for-attention pattern is deliberate and internally consistent.

---

## 7. Recruitment (Teal — per concept §2)

**Routes:** `/recruitment`, `/recruitment/[jobId]`
**Accent:** Teal (per concept §2)

The concept assigns teal to Recruitment with the rationale: "A pipeline is motion, so the layout is a kanban board rather than a list. Teal is cooler and more active than the archival brass of Core HR — this is a workspace, not a record." The concept's design uses teal column headers, teal-tint card backgrounds, and teal stage chips.

### List page — class-by-class

| Element | Classes | Token | Concept reference |
|---|---|---|---|
| **Page `h1`** | `text-2xl font-semibold text-teal` | Teal | Module accent on heading — consistent with other modules |
| Status filter `select` | `focus:border-teal` | Teal focus ring | Module-specific focus ring on a custom element |
| **Table headers** | `text-teal-soft` on `<tr>` | Teal soft | **§2:** Concept's `.khead { color: var(--teal) }` — column headers in teal |
| **CardTitle** | `text-teal-soft` | Teal soft | Section label in muted teal — consistent with Reports pattern |
| **Job title links** | `font-medium text-teal hover:underline` | Teal | **§2:** Concept's `.kcard .name` — interactive elements in teal |
| Location/type metadata | `text-graphite-soft` | Graphite soft | Metadata is neutral — correct |
| Status badges | Semantic tones | Status-agnostic | Correct — status is semantic, not module-specific |
| Empty state icon | `Briefcase h-8 w-8 text-graphite-faint` | Graphite faint | Correct — neutral empty state |

### Job detail page — additional elements

| Element | Classes | Token | Concept reference |
|---|---|---|---|
| "All openings" back link | `text-teal hover:underline` | Teal | Navigation within module — correct |
| Job `h1` | `text-teal` | Teal | Module heading — consistent |
| **Pipeline stage chips** | `border-teal-tint bg-teal-tint text-teal` | Teal-tint bg + teal text | **§2:** Concept's `.kchip { background: #fff; border: 1px solid #C9DEDB; color: var(--teal) }` — stage tags adapted to chips |
| **Stage count badge** | `bg-teal text-paper` | Solid teal bg + white text | Counter pills — teal as "active workspace" color from §2 |
| Description/requirements | `text-graphite-soft whitespace-pre-line` | Graphite soft | Body content is always neutral |
| Candidate rows | `bg-paper-dim rounded-lg` | Neutral paper-dim | Data rows use neutral treatment — correct |
| Candidate stage badge | Semantic tones | Status-agnostic | Correct |
| "Move to" buttons | `Button variant="outline"` | Neutral outline | Transition actions are neutral — accent is on the pipeline chips, not action buttons |

**Verdict:** Clean. Teal follows the concept's kanban logic faithfully — teal is the "active workspace" color for recruitment.

---

## 8. Billing (Brass — PROBLEM, proposed bronze)

**Route:** `/billing`
**Accent:** Currently brass — needs replacement

### Current class-by-class (showing the problem)

| Element | Classes | Token | Problem |
|---|---|---|---|
| **Page `h1`** | `text-2xl font-semibold text-brass` | **Brass** | Same heading color as Core HR |
| **CardTitle** | `text-brass-ink` | **Brass ink** | Same section label as Core HR profile cards |
| **Plan name card** | `bg-brass-tint p-4` | **Brass tint bg** | Same tinted card as Core HR active list item |
| **Plan name value** | `font-display text-2xl text-brass` | **Brass** | Hero number in brass — same as Core HR's register feel |
| **Plan status text** | `text-xs text-brass-ink` | **Brass ink** | Overloaded |
| **Table headers** | `text-brass-ink` | **Brass ink** | Same as Core HR table headers |
| Billing period | `text-graphite-faint` | Graphite faint | Neutral — correct |
| Seats card | `bg-paper-dim` + `text-ink` | Neutral | Correct — data display |
| Plan change buttons | `Button variant="outline"` | Neutral | Correct — admin action |

### The problem

Brass is doing triple duty: Core HR (archival register), brand identity (login/signup gate), and billing (financial ledger). Every accent-bearing element on the billing page reads as "this is a Core HR screen" because they share the same tokens. The two modules become visually indistinguishable.

### Proposed fix: 7th token — Bronze

**Name:** `bronze`
**Rationale:** The concept file's six colors each carry a single meaning. Brass means "archival register" (Core HR). Bronze is a *different metal* — darker, earthier, more oxidized. Where brass reads as warm and prestigious (the record you look someone up in), bronze reads as **settled and durable** (the ledger where accounts are kept). It's financial without being literal money-green (that's Forest/Payroll), and distinct enough from brass that you'd never confuse the two modules.

| Token | Hex | HSL | Derivation |
|---|---|---|---|
| `--color-bronze` | `#8B7355` | 37°, 23%, 44% | 13pp darker, 14pp less saturated than brass |
| `--color-bronze-soft` | `#A38E72` | 37°, 17%, 55% | +11pp lightness, −6pp saturation (follows soft pattern) |
| `--color-bronze-tint` | `#F3EDE6` | 37°, 25%, 93% | Near-white warm parchment |
| `--color-bronze-ink` | `#3D3020` | 37°, 31%, 18% | Dark leather brown |

**How it differs from brass:**

| | Brass | Bronze |
|---|---|---|
| Hex | `#B08D57` | `#8B7355` |
| Lightness | 52% (lighter, golden) | 44% (darker, earthy) |
| Saturation | 37% (warm, present) | 23% (muted, quiet) |
| Feel | Prestige, warmth, the front of the register | Weight, permanence, the back ledger |
| Module | Core HR | Billing |

**Where it would be applied on Billing:**
- Page heading: `text-bronze`
- Subscription card title: `text-bronze-ink`
- Plan card background: `bg-bronze-tint`
- Plan name value: `text-bronze`
- Plan status text: `text-bronze-ink`
- Usage table headers: `text-bronze-ink`

This gives Billing its own visual identity that says "financial/administrative" without borrowing from Core HR's "archival/personnel" meaning.

---

## Complete Accent Map (after bronze)

| Module | Accent | Source | Meaning |
|---|---|---|---|
| Core HR | Brass `#B08D57` | Concept §1 | Archival, dependable — the register |
| Recruitment | Teal `#2F6F6B` | Concept §2 | Active workspace — the pipeline |
| Leave | Wine `#7A3B46` | Concept §3 | Warm, routine — time away |
| Payroll | Forest `#2E5339` | Concept §4 | Literal, clear — the statement |
| Performance | Plum `#5B3C6F` | Concept §5 | Reflective — growth |
| ESS/Dashboard | Cobalt `#3B5C8C` | Concept §6 | Calm workspace — the front door |
| Billing | Bronze `#8B7355` | Proposed | Settled, durable — the ledger |
| Reports | Plum `#5B3C6F` | User decision | Analytical — same family as Performance |
| Notifications | None | Cross-cutting | Cobalt for attention signals only |

---

## Open Items

### Reports/Performance plum sharing — intentional for now

Reports and Performance currently both use plum (`#5B3C6F`). This is intentional: Performance isn't built yet (Phase 4), and the two modules share an analytical spirit — concept §5 describes plum as "reflective rather than clinical, fitting a conversation about growth," which applies to both.

**Flag:** Once Performance ships in Phase 4, Reports will need its own dedicated accent (same pattern as bronze/Billing — a new token that reads as analytical/insightful without conflicting with Performance's reflective plum). Do not silently discover this later; it's a known, tracked decision.

---

## Verification Summary

| Screen | tsc | Build | Server HTML | Hex sweep | Accent audit |
|---|---|---|---|---|---|
| Login | ✓ | ✓ | ✓ Verified live | ✓ Clean | ✓ Brass correct |
| Signup | ✓ | ✓ | ✓ Verified live, no old slate/sky | ✓ Clean | ✓ Brass correct |
| Dashboard | ✓ | ✓ | Source-verified | ✓ Clean | ✓ Cobalt correct |
| Leave | ✓ | ✓ | Source-verified | ✓ Clean | ✓ Wine correct |
| Reports | ✓ | ✓ | Source-verified | ✓ Clean | ✓ Plum correct |
| Notifications | ✓ | ✓ | Auth-gate verified | ✓ Clean | ✓ Neutral + cobalt correct |
| Billing | ✓ | ✓ | Auth-gate verified | ✓ Clean | ✗ Brass overloaded — bronze proposed |
| Recruitment | ✓ | ✓ | Auth-gate verified | ✓ Clean | ✓ Teal correct |
| Job detail | ✓ | ✓ | Dynamic route | ✓ Clean | ✓ Teal correct |
