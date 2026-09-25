# Phase 5 — SSO / OIDC Integration Design

**Status:** Draft for review
**Date:** 2026-09-23
**Scope:** OpenID Connect single sign-on, per-tenant IdP configuration, auth flow integration, user provisioning policy

---

## 1. Existing Interface Assessment

### Current SsoProvider stub

```typescript
// backend/src/modules/integrations/providers.ts:47-49
export interface SsoProvider {
  authenticate(samlResponse: string): Promise<{ authenticated: boolean; userId: string | null }>
}
```

**This interface is insufficient for real SSO.** It fails on every axis:

| Problem | Why it's wrong |
|---|---|
| Takes `samlResponse: string` | SSO doesn't know our internal `userId`. The IdP returns **claims** (email, name), and we look up the user. The interface assumes the IdP already knows our DB schema. |
| Returns `userId: string | null` | We need the IdP's **email claim** to find the user. Returning our internal UUID from the IdP layer is an abstraction inversion. |
| Single parameter name | OIDC doesn't send a "SAML response" — it returns an authorization code, then tokens. The parameter name bakes in a SAML assumption. |
| No tenant context | The IdP to validate against is per-tenant. The interface has no way to receive tenant-specific config (discovery URL, client ID, certificates). |
| No claims output | Even if authentication succeeds, the caller gets no email, no name, no nothing — just a boolean and a userId that shouldn't exist. |

### Verdict: Replace the interface

The stub will be rewritten. The `StubSsoProvider` class will remain as a no-op placeholder (same pattern as `StubCarrierEngine`), but the interface it implements will change. This is safe because the stub is not called anywhere in production — it exists only to satisfy the provider pattern from Phase 4.

---

## 2. Protocol Choice: OIDC (OpenID Connect)

### Recommendation: OIDC as the primary and only protocol for this phase

| Factor | OIDC | SAML 2.0 |
|---|---|---|
| Implementation complexity | Moderate — JSON-based, standard `fetch()` for token exchange | High — XML parsing, XML signature validation, certificate chain verification |
| Token format | JWT (we already validate JWTs for our own auth) | XML assertion (requires XMLDSig library) |
| Discovery | Standard `.well-known/openid-configuration` — auto-configures endpoints | Manual metadata URL parsing, XML parsing, certificate extraction |
| Library support | `openid-client` (mature, well-maintained) | `saml2-js`, `passport-saml` (older, more CVEs) |
| IdP support | Google Workspace, Azure AD, Okta, Auth0, Keycloak — all support OIDC natively | Same IdPs support SAML, but OIDC is their primary development target |
| Our codebase | We already use `fetch()` for outbound HTTP (Integration Hub). OIDC token exchange uses the same pattern. | Would require adding an XML security library. |

### Tradeoff acknowledged

Enterprise buyers sometimes mandate SAML because their compliance requirements or vendor contracts specify it. This is real. However:

1. Every major IdP that supports SAML also supports OIDC. If a customer's IdP supports SAML, it supports OIDC too.
2. SAML can be added as a second protocol in a future phase behind the same interface. The interface design below is protocol-agnostic — it returns claims, not protocol-specific artifacts.
3. Building SAML correctly (XML signature validation, certificate chain verification, assertion encryption) is a significant security surface. Getting OIDC right first — then adding SAML behind the same interface — is lower risk than trying to build both at once.

**If a customer absolutely requires SAML before OIDC is proven in production, that is a scope escalation, not a Phase 5 item.**

---

## 3. Revised SsoProvider Interface

```typescript
// backend/src/modules/integrations/providers.ts (replacement)

export interface SsoClaims {
  /** Email address from the IdP (required — used for user_accounts lookup). */
  email: string
  /** Display name from the IdP (optional — used for logging, not for user matching). */
  name?: string
  /** Arbitrary additional claims from the IdP (stored for future use, not used in auth flow). */
  raw?: Record<string, unknown>
}

export interface SsoConfig {
  /** OIDC discovery metadata URL (e.g., https://accounts.google.com/.well-known/openid-configuration). */
  discoveryUrl: string
  /** OAuth2 client ID issued by the IdP. */
  clientId: string
  /** OAuth2 client secret (encrypted at rest via Integration Hub credential storage). */
  clientSecret: string
  /** Scopes to request (default: 'openid email profile'). */
  scopes?: string[]
  /** HTTP base URL of this Trellis instance (for constructing the callback URL). */
  baseUrl: string
  /** Restrict SSO logins to these email domains. Empty/absent = no restriction. */
  allowedEmailDomains?: string[]
}

export interface SsoProvider {
  /**
   * Exchange an authorization code for claims.
   * Called from the /auth/sso/callback route handler.
   *
   * @param code - The authorization code from the IdP redirect.
   * @param config - Tenant-specific SSO configuration (discovery URL, client ID, secret).
   * @returns Claims if the code is valid and the IdP authenticated the user.
   * @throws On network failure, invalid code, expired token, or signature validation failure.
   */
  exchangeCode(code: string, config: SsoConfig): Promise<SsoClaims>

  /**
   * Generate the OAuth2 authorization URL for redirect.
   * Creates the URL that the frontend redirects the user to.
   *
   * @param config - Tenant-specific SSO configuration.
   * @param state - CSRF state parameter (generated by the backend, stored in session/cookie).
   * @returns The full authorization URL to redirect the user to.
   */
  buildAuthorizeUrl(config: SsoConfig, state: string): string
}
```

### Why this shape

- **`exchangeCode`** — OIDC's core flow is code-for-token exchange. The interface takes the code + tenant config, returns claims. Protocol-agnostic enough that a SAML adapter could implement it by parsing the POST body instead of exchanging a code.
- **`buildAuthorizeUrl`** — The frontend needs a URL to redirect to. This is generated server-side because it includes the client ID, scopes, and CSRF state.
- **`SsoClaims`** — Returns email (required for user lookup), name (optional), and raw claims (for future use). No internal user IDs — that's the auth layer's job, not the SSO provider's.
- **`SsoConfig`** — Tenant-specific. Comes from `sso_config_json` on the `tenants` table (see §4). The `clientSecret` is encrypted via the same Integration Hub credential encryption — decrypted at the point of use, never returned to the caller.

---

## 4. Per-Tenant Configuration

### Storage: `sso_config_json` column on `tenants`

SSO configuration is **core auth infrastructure**, not a third-party integration connection. Storing it in `integration_connections` would conflate "how users log in" with "what external services we talk to." A dedicated column on `tenants` is cleaner.

```sql
ALTER TABLE tenants ADD COLUMN sso_config_json JSONB;
-- NULL = SSO disabled (default). Non-null = SSO enabled for this tenant.
```

**Why a column, not a new table:** SSO config is one row per tenant, always read with the tenant, never queried independently. A JSONB column avoids a JOIN for a field that's accessed on every SSO login attempt.

### Config shape

```json
{
  "provider": "oidc",
  "discoveryUrl": "https://accounts.google.com/.well-known/openid-configuration",
  "clientId": "123456.apps.googleusercontent.com",
  "scopes": ["openid", "email", "profile"],
  "allowedEmailDomains": ["acme.com"],
  "defaultRole": "employee",
  "enforceSso": false
}
```

| Field | Required | Description |
|---|---|---|
| `provider` | yes | `"oidc"` for now. Future: `"saml"`. |
| `discoveryUrl` | yes | OIDC discovery endpoint. Used to auto-configure token, userinfo, and JWKS URLs. |
| `clientId` | yes | OAuth2 client ID (public, not secret). |
| `scopes` | no | Defaults to `["openid", "email", "profile"]`. |
| `allowedEmailDomains` | no | Restrict SSO logins to these email domains. Empty/absent = any domain accepted by the IdP. Strongly recommended. |
| `defaultRole` | yes | Role assigned to newly SSO-provisioned users. Defaults to `"employee"`. |
| `enforceSso` | no | When `true`, password login is disabled for this tenant (see §7). |

### Client secret storage

The OIDC client secret is sensitive. It is **not** stored in `sso_config_json`. Instead:

1. When an admin configures SSO via `PATCH /tenants/:id/sso`, the client secret is passed in the request body.
2. The secret is encrypted using the Integration Hub's `encryptCredential()` with the current `INTEGRATION_HUB_KEY`.
3. The encrypted blob is stored in `integration_connections` with `provider = 'sso_client_secret'` and `label = tenant_id` (one row per tenant).
4. At SSO login time, `dispatchRaw`-style logic decrypts the secret using the master key.

This reuses the envelope encryption infrastructure already built. The secret never touches `sso_config_json`, which remains safe to log/display (it contains only non-secret config).

### New integration_connections provider

```
provider = 'sso_client_secret'
label    = tenant_id (one per tenant)
credential_enc = encrypted client secret
masked_preview = '****' (secret, never shown)
```

---

## 5. Permission Model

### New permissions

| Constant | Value | Who |
|---|---|---|
| `TENANT_READ` | `'tenant:read'` | admin |
| `TENANT_WRITE` | `'tenant:write'` | admin |

### Rationale

**Why admin-only for both read and write:**

- SSO configuration controls how users authenticate to the entire tenant. A misconfiguration (wrong IdP, wrong domain allowlist, `enforceSso` toggle) can lock out every user. This is the highest-risk tenant setting.
- HR managers need visibility into many modules, but authentication infrastructure is not an HR function. If an HR manager needs to check SSO status, the admin does it.
- Managers and employees have no reason to know whether SSO is configured.

### Role assignment (planned)

| Role | TENANT_READ | TENANT_WRITE |
|---|---|---|
| admin | yes | yes |
| hr_manager | no | no |
| manager | no | no |
| employee | no | no |

### Note: existing tenant routes have no permission checks

The only current tenant route is `POST /tenants/signup` (unauthenticated — anyone can create a tenant). The SSO config endpoints (`GET/PATCH/DELETE /tenants/:id/sso`) will be the first tenant management endpoints with permission checks. `TENANT_READ` and `TENANT_WRITE` are new permissions, not yet seeded — they must be added to `permissions.ts` and included in the `admin` role's permission set during implementation.

---

## 6. Auth Flow Integration — The High-Risk Part

### Current login flow (`POST /auth/login`)

```
tenantSubdomain + email + password
  → find tenant by subdomain
  → find user_accounts by email within tenant
  → verify password hash
  → load roles + permissions
  → sign JWT
  → return { accessToken, refreshToken }
```

### SSO login flow (new endpoints)

```
GET /auth/sso/login?tenant=subdomain
  → read sso_config_json from tenant
  → generate CSRF state parameter (random, stored in short-lived session cookie)
  → build OIDC authorization URL with client_id, redirect_uri, scopes, state
  → redirect user to IdP

IdP authenticates user (outside our system)
  → IdP redirects to /auth/sso/callback?code=...&state=...

POST /auth/sso/callback
  → validate state parameter (CSRF protection)
  → exchange authorization code for tokens (OIDC token endpoint)
  → validate ID token (signature, issuer, audience, expiry)
  → extract email claim from ID token or userinfo endpoint
  → check email domain against allowedEmailDomains (see §6.2)
  → if domain not allowed: return 403
  → find user_accounts by employees.work_email (see §6.2)
  → if not found: return 403 with clear error (see §6.1)
  → load roles + permissions
  → sign JWT
  → return { accessToken, refreshToken }
```

### 6.1 First-ever SSO login: the identity-boundary decision

**Rule: SSO does not create users. SSO authenticates existing users.**

If a user authenticates successfully with the IdP (email matches, IdP says "this is a valid user") but no `user_accounts` row exists for that email in the tenant, the login **fails** with:

```
403: SSO authentication succeeded but no account exists for <email> in this tenant.
Contact your administrator to create an account before using SSO.
```

**Why this is the right choice:**

1. **Auto-provisioning is an authentication bypass risk.** If anyone with an email address at the customer's domain can get an account, the tenant's access control is only as good as the IdP's email verification. A misconfigured IdP (or one with lax email domain restrictions) would create accounts for unauthorized people.
2. **Role assignment on auto-provision is ambiguous.** What role does a newly auto-provisioned user get? "employee" seems safe, but in a 3-person startup, that employee might see salary data. The admin needs to explicitly provision the account and assign the role.
3. **The employee record may not exist.** An auto-provisioned `user_accounts` row with no linked `employee` record means `employeeId` is null — breaking leave, attendance, payroll, and every module that assumes a linked employee.
4. **Deletion/deprovisioning is harder.** If a user is deprovisioned from the IdP, what happens to the auto-provisioned account? Without SCIM (explicit non-goal), we'd have orphaned accounts. Requiring pre-provisioning means the admin controls the lifecycle.
5. **Industry precedent.** Workday, BambooHR, and most HRMS platforms require pre-provisioned accounts for SSO. The IdP is an authentication mechanism, not a user-creation mechanism.

**What this means for admins:** Before enabling SSO, the admin must ensure all users who will SSO-login already have `user_accounts` rows. This is standard — the same admin who configures the IdP also provisions users in the HRMS.

### 6.2 Account linking — with domain verification

Before the user_accounts lookup even runs, the authenticating email's domain is checked against the tenant's allowed domains. This prevents an IdP misconfiguration (e.g., lax email domain restrictions) from granting access to arbitrary email addresses.

**Step 1: Domain allowlist check**

`sso_config_json` includes an `allowedEmailDomains` field:

```json
{
  "provider": "oidc",
  "allowedEmailDomains": ["acme.com", "acme-corp.com"],
  ...
}
```

The SSO callback extracts the email from the IdP's ID token, splits off the domain, and checks it against `allowedEmailDomains`:

- If `allowedEmailDomains` is present and non-empty: the email domain **must** be in the list. If not, the login fails with `403: Email domain <domain> is not authorized for SSO on this tenant.`
- If `allowedEmailDomains` is empty or absent: **no domain check is performed.** This is the permissive mode — any email accepted by the IdP is accepted by Trellis. Admins who want strict control must set this field.

**Step 2: User lookup by work email**

After the domain check passes, look up `user_accounts` by joining to `employees`:

```sql
SELECT u.id, u.email, u.status, e.id AS "employeeId"
FROM user_accounts u
JOIN employees e ON e.user_account_id = u.id
WHERE u.tenant_id = $1
  AND lower(e.work_email) = lower($2)
  AND u.deleted_at IS NULL
```

The lookup matches on `employees.work_email`, **not** `user_accounts.email`. Reasons:

1. `user_accounts.email` is the login identifier — it could be a personal email, a previous employer email, or an admin-mismatched value. It is not guaranteed to be the corporate identity.
2. `employees.work_email` is the corporate email — it's what the admin provisions, what the HRMS uses for notifications, and what should match the IdP identity.
3. This means an employee with `user_accounts.email = personal@gmail.com` and `employees.work_email = alice@acme.com` will SSO-login with `alice@acme.com` from the IdP, matching their corporate identity, not their personal login email.

**If no match is found** (no employee with that `work_email` in the tenant): reject with `403: SSO authentication succeeded but no account exists for <email> in this tenant. Contact your administrator to create an account before using SSO.`

**If match is found but `user_accounts.status != 'active'`**: reject with `403: Account is not active. Contact your administrator.`

**If match is found and `status = 'active'`**: proceed. Load roles from `user_roles`, sign JWT, return tokens.

### 6.3 Password login error masking — confirmed

The existing `POST /auth/login` (`auth.routes.ts:30,33,36`) already uses identical error messages for all failure paths: tenant-not-found, user-not-found, user-disabled, and wrong-password all return `403: 'Invalid credentials'`. SSO's callback follows the same pattern — no information leakage about which condition failed. No fix needed.

---

## 7. Fallback Behavior: Password Login Coexistence

### Default: SSO and password coexist

When SSO is enabled for a tenant (`sso_config_json IS NOT NULL`), password login **remains available**. Both paths work. The user can choose.

**Why coexistence by default:**
- Admin accounts often don't have an IdP account (the admin configured the IdP, but their own account might be password-based).
- If SSO breaks (IdP outage), password login is the fallback. Disabling it creates a lockout.
- Gradual rollout: enable SSO for some users while others continue with passwords.

### Opt-in: `enforceSso: true`

The `enforceSso` flag in `sso_config_json` disables password login when set to `true`:

```json
{ "provider": "oidc", "enforceSso": true, ... }
```

When `enforceSso = true`:
- `POST /auth/login` returns 403: `"Password login is disabled for this tenant. Use SSO."`
- Only `POST /auth/sso/login` and `POST /auth/sso/callback` are available.
- Admin password accounts still work if they authenticate via SSO first. If they can't SSO, they must ask another admin to set `enforceSso: false`.

### Lockout prevention

**When `enforceSso` is toggled from `false` to `true` (requires TENANT_WRITE):**
1. At least one admin account must have a linked employee record with a `work_email` whose domain is in `allowedEmailDomains` (or, if `allowedEmailDomains` is empty, any active admin with a linked employee). If not, the toggle is rejected with: `"Cannot enforce SSO: no admin account has a verifiable SSO identity."`
2. This ensures there is always at least one admin who can log in via SSO after the toggle.

**When `enforceSso` is toggled from `true` to `false` (requires TENANT_WRITE):**
- No guard needed. Password login is re-enabled immediately.

---

## 8. API Endpoints

### SSO configuration (admin-only)

| Method | Path | Permission | What |
|---|---|---|---|
| GET | `/tenants/:id/sso` | TENANT_READ | Read SSO config (masked secret, no client secret) |
| PATCH | `/tenants/:id/sso` | TENANT_WRITE | Enable/configure SSO (sets sso_config_json + stores encrypted secret) |
| DELETE | `/tenants/:id/sso` | TENANT_WRITE | Disable SSO (clears sso_config_json + deletes secret from integration_connections) |

### SSO login flow (unauthenticated)

| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/auth/sso/login?tenant=subdomain` | none | Generate authorization URL, redirect to IdP |
| POST | `/auth/sso/callback` | none | Exchange code, validate, issue JWT |

### Response shapes

**GET /tenants/:id/sso:**
```json
{
  "enabled": true,
  "provider": "oidc",
  "discoveryUrl": "https://accounts.google.com/.well-known/openid-configuration",
  "clientId": "123456.apps.googleusercontent.com",
  "scopes": ["openid", "email", "profile"],
  "defaultRole": "employee",
  "enforceSso": false,
  "clientSecretConfigured": true
}
```

Note: `clientSecretConfigured: boolean` — never the actual secret. Just whether one is stored.

**GET /auth/sso/login → 302 redirect** (not JSON):
```
Location: https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=...&response_type=code&scope=openid+email+profile&state=...
```

**POST /auth/sso/callback → same shape as POST /auth/login:**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "...",
  "expiresIn": 900
}
```

---

## 9. Implementation Plan

### Files to create

| File | Purpose |
|---|---|
| `backend/src/modules/sso/oidc-provider.ts` | OIDC discovery, code exchange, token validation, claims extraction |
| `backend/src/modules/sso/sso.repo.ts` | Read/write `sso_config_json`, lookup user by email |
| `backend/src/modules/sso/sso.routes.ts` | SSO config endpoints + login/callback endpoints |
| `backend/src/modules/sso/sso.config.ts` | SSO config type definitions + validation schemas |

### Files to modify

| File | Change |
|---|---|
| `phase5-sso.sql` | `ALTER TABLE tenants ADD COLUMN sso_config_json JSONB` |
| `backend/src/db/schema.ts` | Register `applySsoSchema()` migration |
| `backend/src/db/index.ts` | Register `phase5-sso` migration |
| `backend/src/http/app.ts` | Register SSO routes |
| `backend/src/modules/auth/auth.routes.ts` | Add `enforceSso` check to `/auth/login` |
| `backend/src/modules/integrations/providers.ts` | Replace SsoProvider interface |
| `backend/src/modules/permissions.ts` | Add TENANT_READ, TENANT_WRITE; assign to admin role (matching §5 role table) |
| `backend/src/seed/seed.ts` | (optional) seed SSO config for demo tenant |

### Dependencies

| Package | Purpose | Risk |
|---|---|---|
| `openid-client` | OIDC discovery, code exchange, token validation | Mature, well-maintained, no native deps. Low risk. |

**No XML library needed** — OIDC is entirely JSON/JWT-based. The ID token is a JWT, which we already validate with `@fastify/jwt`.

### Migration path

1. Create `phase5-sso.sql` with the `sso_config_json` column addition.
2. Implement `oidc-provider.ts` (discovery + code exchange + token validation).
3. Implement `sso.repo.ts` (config read/write, user lookup by email).
4. Implement `sso.routes.ts` (config endpoints + login/callback).
5. Wire into `auth.routes.ts` (enforceSso check).
6. Replace stub interface in `providers.ts`.
7. Typecheck + tests.

---

## 10. Explicit Non-Goals

| Non-goal | Why deferred |
|---|---|
| **SCIM / automatic user provisioning** | Requires a SCIM server endpoint, ongoing sync protocol, conflict resolution. Significant complexity. Deferred to Phase 6+. |
| **Multiple simultaneous IdPs per tenant** | Adds routing logic (which IdP to use for which user), config complexity, and ambiguity about which IdP "owns" a user. Single IdP per tenant is sufficient for Phase 5. |
| **Just-in-time role assignment from IdP group claims** | Requires mapping IdP group names to internal roles — a per-tenant configuration problem that's different from the auth flow. SSO users get a configurable `defaultRole` for now. Group-to-role mapping deferred. |
| **SAML 2.0 protocol support** | Higher implementation complexity (XML signature validation). Can be added behind the same `SsoProvider` interface in a future phase. OIDC covers the same IdPs. |
| **MFA via SSO** | MFA is IdP-side. If the IdP requires MFA, SSO users get it automatically. We don't need to implement MFA ourselves for SSO users. Our existing `mfa_enabled` + TOTP is for password-login users only. |
| **Service provider-initiated (SP-initiated) SSO** | The flow described is IdP-initiated (user starts at our login page, gets redirected to IdP). SP-initiated (user starts at IdP, gets redirected to our app) is a future enhancement. |
| **Single logout (SLO)** | Logging out of Trellis should not log out of the IdP, and vice versa. SLO is complex, rarely works reliably across IdPs, and is not a Phase 5 requirement. |

---

## 11. Security Considerations

| Risk | Mitigation |
|---|---|
| **CSRF on /auth/sso/callback** | State parameter: random 32-byte value generated server-side, stored in an HttpOnly cookie, validated on callback. One-time use. |
| **Replay of authorization code** | OIDC codes are single-use by spec. The token exchange fails on replay. |
| **Token signature forgery** | ID token is validated against the IdP's JWKS (fetched from discovery metadata). Signature verification is mandatory. |
| **Open redirect via redirect_uri** | `redirect_uri` is constructed server-side from the tenant's `baseUrl` in `sso_config.json`. Not user-supplied. |
| **Account enumeration** | SSO callback returns the same error for "no account" and "account disabled" — never reveals which condition failed. |
| **Client secret leakage** | Stored encrypted via Integration Hub envelope encryption. Never returned in API responses. Never logged. Decrypted only at point of use (token exchange). |
| **IdP metadata tampering** | Discovery document is fetched over HTTPS. JWKS keys are pinned per-fetch (not cached long-term). |

---

## 12. Relationship to Other Modules

### SSO configuration prerequisite

SSO can only be configured on an existing tenant that already has at least one provisioned admin user account. The `PATCH /tenants/:id/sso` endpoint requires the tenant to exist and have an active admin — this is not part of initial tenant signup. The signup flow (`POST /tenants/signup`) does not configure SSO. An admin must first create the tenant, then configure SSO as a separate step.

### Module relationships

| Module | Relationship |
|---|---|
| **Integration Hub** | Reuses credential encryption for client secret storage. SSO is an integration provider (`sso_client_secret`) in `integration_connections`. |
| **Auth** | SSO is an alternative authentication path. The JWT it produces is identical to password-login JWTs. All downstream modules are SSO-agnostic. |
| **Tenants** | SSO config is a tenant-level setting (`sso_config_json`). Tenant admins configure SSO. |
| **Employees** | SSO does not create or modify employee records. It authenticates existing `user_accounts` that may or may not have linked employees. Account linking uses `employees.work_email` (§6.2). |
| **All other modules** | No relationship. SSO is purely an auth-path change. Modules see the same `req.ctx.userId` regardless of how the user authenticated. |
