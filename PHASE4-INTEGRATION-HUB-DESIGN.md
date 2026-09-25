# Phase 4 — Integration Hub Design

**Status:** Draft for review  
**Date:** 2026-09-23  
**Scope:** Third-party credential storage, outbound integration dispatch, Slack webhook proof-of-concept, stub interfaces for SSO/payroll/accounting/calendar/job boards

---

## 1. Architectural Context

This module is architecturally different from Payroll, Performance, and Benefits. Those are CRUD modules — they read and write tenant-scoped rows through the same `db.tenant()` path with RLS enforcement. Integration Hub is an **external boundary** module: it stores third-party credentials, makes outbound HTTP calls to external services, and needs to handle failure, timeout, and retry at the network level.

The risk profile is closer to the AI Agent Service (which calls Anthropic/Groq via outbound `fetch`) than to the CRUD modules. The critical difference from the AI module is that Integration Hub credentials are **per-tenant** (stored in the DB, not env vars) and the outbound calls are **dispatched from domain events** (leave approval → Slack notification) rather than from a user-initiated chat turn.

---

## 2. Credential Storage

### Problem

The codebase has zero encryption-at-rest capability. The `benefit_dependents.ssn_enc` column is a naming convention only — the value is stored as plaintext TEXT. API keys in the AI module are env vars (`process.env.GROQ_API_KEY`), not per-tenant.

Integration Hub needs **real per-tenant credential encryption** because:
- Multiple tenants on the same Postgres instance cannot share an env var
- OAuth tokens and API keys are high-value targets — plaintext in DB is unacceptable
- Credentials must never be returned to the frontend (masked display only)

### Design

#### Encryption approach

Use Node.js native `crypto` module — AES-256-GCM (authenticated encryption) in an **envelope encryption** scheme. No new dependencies.

- **Master key (KEK)**: 32-byte key from `INTEGRATION_HUB_KEY` environment variable (base64-encoded). Required at boot if any integration is configured; optional otherwise. Used only to wrap/unwrap data keys, never to encrypt credentials directly.
- **Per-credential data key (DEK)**: Each credential gets a randomly generated 256-bit AES key. This DEK encrypts the actual credential payload. The DEK is itself encrypted (wrapped) by the master key.
- **Stored format**: The `credential_enc` column stores four hex-encoded components separated by colons:
  ```
  wrapped_dek_iv:wrapped_dek_ciphertext:wrapped_dek_tag:encrypted_payload
  ```
  Where `encrypted_payload` is `iv:ciphertext:tag` (the DEK-encrypted credential). Total: 6 colon-separated hex fields.
- **Why envelope encryption**: Rotating the master key (e.g., on compromise) only requires re-wrapping each DEK with the new master key — no re-encryption of the credential payloads themselves. This is cheaper and safer than re-encrypting every credential with the master key directly.
- **Never decrypted in routes**: The decrypted credential is only materialized at the point of use (inside the outbound call function or the verify/test endpoints), not in route handlers or list queries. This minimizes the window where secrets are in memory.

#### Helper functions

```typescript
// backend/src/lib/credential-encryption.ts

export interface EncryptedCredential {
  /** Master-key-wrapped data key: "iv:ciphertext:tag" (hex) */
  wrappedDek: string
  /** DEK-encrypted credential: "iv:ciphertext:tag" (hex) */
  encryptedPayload: string
  /** Which master key version was used to wrap the DEK */
  keyVersion: number
}

export function encryptCredential(plaintext: string, masterKey: Buffer, keyVersion: number): EncryptedCredential
// Generates random 32-byte DEK, encrypts plaintext with DEK (AES-256-GCM),
// wraps DEK with master key (AES-256-GCM). Returns both components + keyVersion.

export function decryptCredential(enc: EncryptedCredential, masterKey: Buffer): string
// Unwraps DEK with master key, decrypts payload with DEK.
// Throws on tampering (GCM auth tag verification on either layer).

export function serializeCredential(enc: EncryptedCredential): string
// Returns "wrappedDek_iv:wrappedDek_ct:wrappedDek_tag:payload_iv:payload_ct:payload_tag"

export function parseCredential(serialized: string): EncryptedCredential
// Reverses serializeCredential. Throws on malformed input.

export function maskCredential(plaintext: string): string
// Returns masked display: "sk-...3f2a" (last 4 chars visible, rest masked).
// For short strings (<8 chars): returns "****".
```

#### Key rotation procedure

The `key_version` column tracks which master key encrypted each credential. When the master key is rotated (new `INTEGRATION_HUB_KEY` env var):

1. Update `INTEGRATION_HUB_KEY` to the new key. Set `CURRENT_KEY_VERSION` to the new version (e.g., `2`). New credentials will use this key from now on.
2. Existing credentials at the old `key_version` are now undecryptable from ambient config alone — the old key is gone from the environment by design.
3. Run a one-shot rotation script that takes the **previous key** as an explicit CLI argument (not read from env). The script selects `WHERE key_version < $currentVersion`, decrypts with the old key, re-encrypts with the current key, and updates `credential_enc` and `key_version`.
4. Once all rows are re-wrapped, the old key is no longer needed anywhere.

This is a deliberately manual, infrequent process. It is not automated. The operator must have the previous key available (e.g., from a secrets manager, a sealed envelope, or a password vault) at rotation time. If the previous key is lost, existing credentials must be re-entered by the tenant admin — there is no recovery path from the DB alone.

> **⚠ Rotation is deferred — not implemented in Phase 4.** The `key_version` column and envelope encryption structure (KEK/DEK separation) are groundwork only. No rotation script exists. The config holds a single key. **Rotating `INTEGRATION_HUB_KEY` today — without building the multi-key mechanism first — would make all previously-encrypted credentials permanently undecryptable.** The old key is not stored anywhere the code can reach. Do not rotate the key until the rotation script is built and tested.

#### Master key loading

```typescript
// backend/src/config.ts addition
integrationHubKey: env.INTEGRATION_HUB_KEY
  ? Buffer.from(env.INTEGRATION_HUB_KEY, 'base64')
  : undefined,
currentKeyVersion: Number(env.CURRENT_KEY_VERSION ?? 1),
```

If `INTEGRATION_HUB_KEY` is not set, all credential save/rotate/delete operations fail with a clear error: `"Integration Hub encryption key not configured (INTEGRATION_HUB_KEY)"`. This is a hard fail — no fallback to plaintext.

### New table: `integration_connections`

```sql
CREATE TABLE integration_connections (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id),
    provider         TEXT NOT NULL,                    -- 'slack_webhook', 'sso_saml', 'quickbooks', ...
    label            TEXT NOT NULL,                    -- human-readable name: "Acme Slack Workspace"
    credential_enc   TEXT NOT NULL,                    -- envelope-encrypted blob (6 colon-separated hex fields)
    masked_preview   TEXT NOT NULL,                    -- computed once at save time, never re-derived
    key_version      SMALLINT NOT NULL DEFAULT 1,     -- which master key encrypted this credential
    status           TEXT NOT NULL DEFAULT 'disconnected'
                     CHECK (status IN ('connected', 'disconnected', 'error', 'verifying')),
    config_json      JSONB,                            -- non-secret config (webhook URL, domain, etc.)
    last_verified_at TIMESTAMPTZ,
    last_error       TEXT,                             -- most recent error message (cleared on success)
    created_by       UUID REFERENCES user_accounts(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections FORCE ROW LEVEL SECURITY;
```

**`masked_preview` column**: Computed once at credential-save time by calling `maskCredential(plaintext)` and storing the result. This means GET endpoints can return the masked display value by reading `masked_preview` directly — **no decryption, no master key needed**. The column is overwritten on every credential save/rotate.

**Why `credential_enc` is a single blob, not separate columns**: Different providers have different credential shapes (Slack = one webhook URL, SSO = SAML cert + key + metadata URL, payroll = API key + secret + merchant ID). A single encrypted JSON blob accommodates all shapes without schema changes per provider. The `config_json` column holds non-secret configuration that can be displayed and queried.

**Why `status` is a column, not derived**: Status reflects the result of the last verification attempt. It's expensive to verify (network call) and shouldn't be computed on every read. The `verifying` state exists for the brief window during an active verification attempt.

---

## 3. Scope — What's Real vs. Stubbed

### In scope for this phase

| Integration | Type | Status | Rationale |
|---|---|---|---|
| **Slack webhook** | Outbound webhook | **Real** | Simple auth (URL-only), low risk, natural hook via existing Notifications module, proves the full pattern end-to-end |

### Stubbed for this phase (interface + stub, ready for real implementation)

| Integration | Type | Interface | Stub behavior |
|---|---|---|---|
| **SSO/SAML** | Inbound auth | `SsoProvider` | Returns `authenticated: false` |
| **Payroll partner** (ADP/Gusto) | Outbound API | `PayrollPartner` | Returns `submitted: false` |
| **Accounting system** (QuickBooks/Xero) | Outbound API | `AccountingSync` | Returns `synced: false` |
| **Calendar** (Google/Outlook) | Outbound API | `CalendarIntegration` | Returns `created: false` |
| **Job boards** (LinkedIn/Indeed) | Outbound API | `JobBoardPublisher` | Returns `published: false` |
| **Background check / e-signature** | Outbound API | `VendorIntegration` | Returns `initiated: false` |

Each stub follows the same pattern as `StubCarrierEngine` and `StubTaxEngine`:
- Interface defining the contract (input/output types + methods)
- Stub class implementing the interface, returning `false`/`null` sentinel values
- Module-level singleton (`const slackEngine: SlackEngine = new StubSlackEngine()`)
- Real implementation drops in behind the same interface later

### Why Slack webhook is the right proof-of-concept

1. **Credential is trivial** — a single URL (no OAuth flow needed for incoming webhooks)
2. **Fits the existing notification model perfectly** — `notify()` writes a DB row, Integration Hub can subscribe to notification events and dispatch to Slack
3. **Fire-and-forget is natural** — Slack webhook failure shouldn't block leave approval, and Slack's own retry guidance is "if it fails, drop it"
4. **Visible immediately** — connecting a Slack webhook and approving a leave request produces a real message in a real channel. This is a demo-able end-to-end flow.

---

## 4. Outbound Call Safety

### Problem

The codebase currently has zero timeout/retry configuration on outbound `fetch()` calls. The AI agent calls Anthropic/Groq with bare defaults. If a third-party service hangs, the Fastify request handler hangs. If it times out, the error propagates unhandled. This is acceptable for an AI chat turn (user expects latency) but unacceptable for domain-event dispatch (leave approval must not block on Slack).

### Two dispatch modes

The outbound call layer serves two distinct purposes with different timing contracts:

| Mode | Called from | Timing | Caller awaits? | Use case |
|---|---|---|---|---|
| `dispatch()` | Post-commit hooks (leave approval, onboarding, ATS) | After transaction commits | No — fire-and-forget | Domain-event side effects |
| `dispatchSync()` | Route handlers (`/verify`, `/test`) | Inside request lifecycle | Yes — awaited with timeout | User-initiated actions that need a response |

Both share the same underlying HTTP call logic (timeout, error handling, audit logging). The difference is whether the caller sees the result.

### Shared core: `dispatchRaw()`

```typescript
// backend/src/modules/integrations/dispatch.ts

interface DispatchResult {
  ok: boolean
  provider: string
  connectionId: string
  durationMs: number
  error?: string
}

/**
 * Core outbound call logic. Opens its own db.tenant() transaction
 * for credential lookup and audit logging. Never throws.
 */
async function dispatchRaw(
  db: Db,
  tenantId: string,
  provider: string,
  payload: unknown,
  opts?: { timeoutMs?: number },
): Promise<DispatchResult>
```

**Behavior:**
1. Opens `db.tenant(tenantId, async (q) => { ... })` internally — no external `q` parameter
2. Inside that transaction: looks up `integration_connections` row where `provider = provider AND status = 'connected'`
3. If not found or status != 'connected', returns `{ ok: false, error: 'not connected' }` — **no throw**
4. Decrypts credential using master key (DEK unwrapping + payload decryption)
5. Makes outbound HTTP call with `AbortSignal.timeout(opts?.timeoutMs ?? 10_000)`
6. Logs the attempt to `audit_logs` via the same `q` (action: `integration.dispatch.{provider}`, success/failure, duration — **never log payload contents**)
7. Updates `last_verified_at` on success, `last_error` on failure
8. Returns result — **never throw**

### Fire-and-forget: `dispatch()`

```typescript
/**
 * Fire-and-forget dispatch for post-commit hooks.
 * Opens its own db.tenant() internally. Caller does not await.
 */
async function dispatch(
  db: Db,
  tenantId: string,
  provider: string,
  payload: unknown,
  opts?: { timeoutMs?: number },
): Promise<void> {
  dispatchRaw(db, tenantId, provider, payload, opts).catch(() => {})
}
```

The return is `Promise<void>` — the caller explicitly does not see the result. Errors are swallowed after logging inside `dispatchRaw`.

### Synchronous: `dispatchSync()`

```typescript
/**
 * Awaited dispatch for user-initiated actions (/verify, /test).
 * Returns the full result so the route handler can respond to the admin.
 */
async function dispatchSync(
  db: Db,
  tenantId: string,
  provider: string,
  payload: unknown,
  opts?: { timeoutMs?: number },
): Promise<DispatchResult> {
  return dispatchRaw(db, tenantId, provider, payload, opts)
}
```

Used by `/integrations/:id/verify` and `/integrations/:id/test` — the admin needs to see success or failure in the response. The underlying call logic is identical to `dispatch()`; the only difference is that the result is returned, not swallowed.

### Key invariants

- **`dispatchRaw` opens its own `db.tenant()`** — it does not accept an external `q`. This is required because it's called post-commit, after the originating transaction has closed.
- **`dispatchRaw` never throws** — all errors are caught, logged to audit, and returned in the `DispatchResult`.
- **`dispatch()` never blocks the caller** — fire-and-forget, swallowed promise.
- **`dispatchSync()` always returns a result** — the caller awaits and uses it.

### Retry policy

**This phase:** No retry. Single attempt, log success/failure, move on. Rationale:
- Slack webhooks are best-effort by design
- Retry logic per-provider is provider-specific (Slack recommends no retry, payroll partners may need exponential backoff)
- Adding retry now would be speculative — we don't know the failure modes yet

**Future:** Provider-specific retry policies configured in a `provider_configs` map. Deferred to Explicit Non-Goals.

---

## 5. Permission Model

### New permissions

| Constant | Value | Who |
|---|---|---|
| `INTEGRATIONS_READ` | `'integrations:read'` | admin, hr_manager |
| `INTEGRATIONS_WRITE` | `'integrations:write'` | admin only |

### Rationale

**Write is admin-only** because:
- Credential access = ability to impersonate the tenant to third parties
- Only admins should connect/disconnect/configure integrations
- HR managers need visibility (is Slack connected?) but not credential management

**Read is admin + hr_manager** because:
- HR managers need to see integration status (e.g., "is our payroll partner connected?" before running payroll)
- Read returns status, label, `masked_preview`, `last_verified_at`, `last_error` — never `credential_enc`
- Read access does not expose anything that an admin hasn't already configured

**Managers and employees get zero access** to integration endpoints — no read, no write. Integration status is not relevant to their workflow.

### Role assignment (planned)

| Role | INTEGRATIONS_READ | INTEGRATIONS_WRITE |
|---|---|---|
| admin | yes | yes |
| hr_manager | yes | no |
| manager | no | no |
| employee | no | no |

---

## 6. Audit

### Actions logged

| Action | When | `before_state` | `after_state` |
|---|---|---|---|
| `integration.connection.created` | Credential saved | null | `{ provider, label, status }` |
| `integration.connection.updated` | Credential rotated or config changed | `{ status, label }` | `{ status, label }` |
| `integration.connection.deleted` | Credential deleted | `{ provider, label }` | null |
| `integration.dispatch.{provider}` | Outbound call (dispatch, /verify, /test) | — | `{ ok: boolean, durationMs, error? }` |

**Credential content is never logged.** Audit entries log provider name, label, and status — never the credential blob, webhook URL, or API key. The `before_state`/`after_state` for connection CRUD contains only metadata.

**Outbound call audit logs the result, not the payload.** We log that a Slack message was sent (or failed), its duration, and whether it succeeded — never the message content.

**There is no separate `connection.verified` action.** The `/verify` and `/test` endpoints use `dispatchSync()`, which calls `dispatchRaw()`, which writes `integration.dispatch.{provider}`. This is the same audit action as fire-and-forget dispatch — the outbound call is the auditable event, regardless of whether it was triggered by a domain event or an admin click. Adding a second audit entry for the same HTTP call would be redundant. The `/verify` route handler also updates `last_verified_at` and `last_error` on the connection row (inside its own `db.tenant()` transaction), which is the record of the verification attempt — separate from the dispatch audit entry.

### Pattern

All audit calls use the existing `audit(q, entry)` function from `backend/src/lib/audit.ts`. For connection CRUD, audit is called inside the `db.tenant()` transaction in the route handler. For outbound dispatch, audit is called inside `dispatchRaw`'s own `db.tenant()` transaction using `actorType: 'system'`.

---

## 7. API Endpoints

### Connection management (admin-only write, admin+HR read)

| Method | Path | Permission | Who | What |
|---|---|---|---|---|
| GET | `/integrations` | INTEGRATIONS_READ | admin, hr_manager | List connections (masked_preview, status, metadata) |
| GET | `/integrations/:id` | INTEGRATIONS_READ | admin, hr_manager | Get single connection detail |
| POST | `/integrations` | INTEGRATIONS_WRITE | admin | Create connection (save encrypted credential) |
| PATCH | `/integrations/:id` | INTEGRATIONS_WRITE | admin | Update connection (rotate credential, change config) |
| DELETE | `/integrations/:id` | INTEGRATIONS_WRITE | admin | Delete connection (soft-delete: set status=disconnected, wipe credential_enc and masked_preview) |
| POST | `/integrations/:id/verify` | INTEGRATIONS_WRITE | admin | Trigger verification — **awaits result**, returns status to admin |
| POST | `/integrations/:id/test` | INTEGRATIONS_WRITE | admin | Send test payload — **awaits result**, returns success/failure to admin |

### Response shape for GET

```json
{
  "id": "...",
  "provider": "slack_webhook",
  "label": "Acme Slack #general",
  "status": "connected",
  "config": { "channel": "#general" },
  "maskedCredential": "https://hooks.slack.com/...3f2a",
  "lastVerifiedAt": "2026-09-23T10:00:00Z",
  "lastError": null,
  "createdBy": "admin@acme.com",
  "createdAt": "2026-09-22T14:00:00Z"
}
```

The `credential_enc` column is **never included** in any API response. The `maskedCredential` field is read directly from the `masked_preview` column — no decryption, no master key needed at read time.

### Response shape for `/verify` and `/test`

```json
{
  "ok": true,
  "provider": "slack_webhook",
  "connectionId": "...",
  "durationMs": 342,
  "status": "connected",
  "lastVerifiedAt": "2026-09-23T10:15:00Z",
  "lastError": null
}
```

On failure:
```json
{
  "ok": false,
  "provider": "slack_webhook",
  "connectionId": "...",
  "durationMs": 10023,
  "status": "error",
  "lastVerifiedAt": "2026-09-23T10:15:00Z",
  "lastError": "Request timed out after 10s"
}
```

These endpoints use `dispatchSync()` — the HTTP call is made, the result is awaited, and the admin sees the real outcome in the response. The connection's `status` and `last_error` are also updated as a side effect.

---

## 8. Slack Webhook — Proof-of-Concept Detail

### How it integrates with Notifications

The existing notification system is in-app only: `notify()` inserts a row into `notifications`, the frontend polls via REST. Integration Hub adds an **outbound dispatch** layer:

1. Domain event occurs (e.g., leave approved)
2. `notify(q, {...})` writes to `notifications` table (existing behavior, same transaction)
3. After the transaction commits, `dispatch(db, tenantId, 'slack_webhook', payload)` is called
4. `dispatch` opens its own `db.tenant()`, looks up the Slack webhook connection, decrypts the URL, makes the POST
5. Result is logged to `audit_logs` inside that internal transaction

This is a **post-commit hook** pattern. The dispatch is decoupled from the domain event transaction — if Slack is down, the notification is still in the DB and the leave request is still approved.

### Slack message format

```json
{
  "text": "*Leave Request Approved*\nAisha Patel's vacation (Sep 25-27) has been approved by Priya Sharma."
}
```

Simple Slack mrkdwn. No blocks, no attachments — keep the proof-of-concept minimal. Real implementations can use Slack's Block Kit.

### Where dispatch is called

Each existing `notify()` call site gets a post-commit dispatch call:

| Module | Event | Current `notify()` location |
|---|---|---|
| Leave | `leave.approved` / `leave.rejected` | `leave.routes.ts:213` |
| Onboarding | `onboarding.*_completed` | `onboarding.routes.ts:368` |
| ATS | `employee.hired` | `ats.routes.ts:193` |

The dispatch call is added **after** the `db.tenant()` block returns, not inside it:

```typescript
// Before (existing):
await db.tenant(tenantId, async (q) => {
  // ... approve leave ...
  await notify(q, { tenantId, recipientUserId, type: 'leave.approved', ... })
})
return { approved: true }

// After (new):
const result = await db.tenant(tenantId, async (q) => {
  // ... approve leave ...
  await notify(q, { tenantId, recipientUserId, type: 'leave.approved', ... })
})
// Fire-and-forget: dispatch to Slack if connected.
// dispatch() opens its own db.tenant() internally — no q needed.
dispatch(db, tenantId, 'slack_webhook', {
  text: `*Leave Request Approved*\n${employeeName}'s ${leaveType} (${startDate} - ${endDate}) has been approved by ${managerName}.`
}).catch(() => {})  // swallow — dispatch already logs errors internally
return result
```

The `.catch(() => {})` is intentional — `dispatch` handles its own errors internally and logs them. The caller should never await or handle dispatch failures.

### Where dispatchSync is used

The verify and test endpoints use `dispatchSync()` instead of `dispatch()`:

```typescript
// POST /integrations/:id/verify
fastify.post('/integrations/:id/verify', { preHandler: [...] }, async (req) => {
  const { id } = req.params as { id: string }
  // ... ownership/admin checks ...

  const connection = await db.tenant(req.ctx.tenantId, async (q) => {
    return repo.getIntegrationConnection(q, id)
  })

  // dispatchSync opens its own db.tenant() — uses the shared HTTP call logic
  const result = await dispatchSync(db, req.ctx.tenantId, connection.provider, {
    // test payload: empty or provider-specific ping
  })

  return { ...result, status: connection.status }
})
```

The admin sees the real result: success, failure, timeout, or "not connected."

---

## 9. Relationship to Other Modules

| Module | Relationship |
|---|---|
| **Notifications** | Integration Hub reads notification events and dispatches outbound. `notify()` is unchanged — Integration Hub is a consumer, not a modifier. |
| **Leave** | Leave approval triggers Slack dispatch. Integration Hub is called post-commit, not inside the leave transaction. |
| **Onboarding** | Onboarding completion triggers Slack dispatch. Same post-commit pattern. |
| **ATS** | Employee hired triggers Slack dispatch. Same post-commit pattern. |
| **Payroll** | Future: payroll partner integration reads payroll_runs and transmits to ADP/Gusto. Stubbed this phase. |
| **Benefits** | Future: benefits carrier integration already has its own stub (CarrierEngine). Integration Hub is for new carriers, not a replacement. |
| **AI Agent** | No relationship. AI uses env-var API keys, not per-tenant credentials. |
| **Auth** | Future: SSO/SAML integration would hook into the login flow. Stubbed this phase. |

---

## 10. File Structure

### New files

| File | Purpose |
|---|---|
| `phase4-integrations.sql` | DDL for `integration_connections` table |
| `backend/src/modules/integrations/integrations.repo.ts` | CRUD queries for integration_connections |
| `backend/src/modules/integrations/integrations.routes.ts` | HTTP endpoints (7 routes) |
| `backend/src/modules/integrations/dispatch.ts` | Outbound call safety layer (`dispatchRaw`, `dispatch`, `dispatchSync`) |
| `backend/src/modules/integrations/providers/slack-webhook.ts` | Real Slack webhook engine |
| `backend/src/modules/integrations/providers/slack-stub.ts` | Stub Slack engine (returns `sent: false`) |
| `backend/src/modules/integrations/providers/sso-stub.ts` | Stub SSO engine (returns `authenticated: false`) |
| `backend/src/modules/integrations/providers/payroll-partner-stub.ts` | Stub payroll partner |
| `backend/src/modules/integrations/providers/accounting-stub.ts` | Stub accounting sync |
| `backend/src/modules/integrations/providers/calendar-stub.ts` | Stub calendar integration |
| `backend/src/modules/integrations/providers/job-board-stub.ts` | Stub job board publisher |
| `backend/src/modules/integrations/providers/vendor-stub.ts` | Stub background check / e-signature |
| `backend/src/lib/credential-encryption.ts` | AES-256-GCM envelope encryption: encrypt/decrypt/serialize/parse/mask |
| `backend/test/integrations.test.ts` | Live DB integration tests |

### Modified files

| File | Change |
|---|---|
| `backend/src/db/schema.ts` | Add `integration_connections` to `TENANT_SCOPED_TABLES`, add `applyIntegrationsSchema()` |
| `backend/src/db/index.ts` | Register `phase4-integrations` migration |
| `backend/src/config.ts` | Add `integrationHubKey` config |
| `backend/src/modules/permissions.ts` | Add `INTEGRATIONS_READ`, `INTEGRATIONS_WRITE` |
| `backend/src/http/app.ts` | Register integration routes |
| `backend/src/seed/seed.ts` | Seed a demo Slack webhook connection (status: disconnected) |
| `backend/src/modules/leave/leave.routes.ts` | Add post-commit Slack dispatch |
| `backend/src/modules/onboarding/onboarding.routes.ts` | Add post-commit Slack dispatch |
| `backend/src/modules/ats/ats.routes.ts` | Add post-commit Slack dispatch |

---

## 11. Explicit Non-Goals

| Deferred | Rationale |
|---|---|
| **Real OAuth flows** (SSO/SAML, Google Calendar, QuickBooks) | OAuth requires redirect URIs, token refresh, provider-specific flows. Stub first, one real proof-of-concept (Slack webhook) to validate the pattern, real OAuth later. |
| **Integration marketplace UI** | A browseable marketplace of connectable services is a product-level feature, not a Phase 4 backend concern. The API supports it; the UI is deferred. |
| **Inbound webhooks** (receiving Slack slash commands, SSO callbacks) | Requires public URL routing, CSRF protection, signature verification per provider. Separate architectural concern from outbound dispatch. |
| **Provider-specific retry/backoff** | Each provider has different retry semantics (Slack: none, payroll: exponential, SSO: redirect). Tuning this requires production failure data we don't have yet. |
| **Credential rotation automation** | Token refresh for OAuth providers (Slack bot tokens expire, SAML certs rotate). Deferred until real OAuth is implemented. |
| **Rate limiting per provider** | Provider-specific rate limits (Slack: 1/sec per webhook, ADP: 100/min). Deferred until real providers are connected. |
| **Bidirectional sync** (accounting, calendar) | Reading FROM third parties (pulling invoices, events) is a different pattern from outbound dispatch. Deferred. |

---

## 12. Open Questions

1. **Should `dispatch()` be async fire-and-forget at the call site, or should it be awaited with a timeout?**  
   **Resolved:** Both modes exist. `dispatch()` is fire-and-forget for post-commit hooks. `dispatchSync()` is awaited for user-initiated actions (`/verify`, `/test`). Both use the same `dispatchRaw()` core.

2. **Should the dispatch call be inside or outside the `db.tenant()` transaction?**  
   **Resolved:** Outside, after commit. The notification is already in the DB (committed). Dispatch opens its own `db.tenant()` internally for credential lookup and audit logging. This is required because the originating transaction has already closed.

3. **Should `config_json` be encrypted too?**  
   **Recommendation:** No. `config_json` holds non-secret metadata (channel name, workspace ID, domain). Encrypting it would make it unqueryable and un-displayable. Only `credential_enc` holds secrets.

4. **What happens if `INTEGRATION_HUB_KEY` is not set?**  
   **Resolved:** GET/list endpoints work without the key — they read `masked_preview` directly, no decryption needed. Credential save/rotate/delete and outbound dispatch fail with a clear error. Verify/test endpoints fail with a clear error. The module is partially functional (read-only) without the key.

5. **Should the soft-delete (DELETE endpoint) actually wipe `credential_enc`?**  
   **Recommendation:** Yes. Delete sets `status = 'disconnected'`, overwrites `credential_enc` and `masked_preview` with empty strings, and logs the deletion. This ensures the credential is irrecoverable from the DB after deletion. If the tenant reconnects, they must re-enter the credential.

6. **Should dispatch use `actorType: 'system'` for audit, or `actorType: 'user'`?**  
   **Recommendation:** `actorType: 'system'` with `actorId: null`. The dispatch is triggered by a system process (post-commit hook), not by a direct user action. The originating user is already recorded in the domain event's audit entry.
