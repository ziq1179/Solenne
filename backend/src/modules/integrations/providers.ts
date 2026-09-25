/**
 * Integration provider interfaces + implementations.
 *
 * Slack webhook is real (outbound POST, proves the full pattern).
 * All others are stubs — same pattern as StubCarrierEngine.
 */

// ─── Slack Webhook ────────────────────────────────────────────────────────────

export interface SlackPayload {
  text: string
  channel?: string
}

export interface SlackResult {
  ok: boolean
  statusCode: number
  error?: string
}

export interface SlackEngine {
  send(webhookUrl: string, payload: SlackPayload): Promise<SlackResult>
}

export class RealSlackEngine implements SlackEngine {
  async send(webhookUrl: string, payload: SlackPayload): Promise<SlackResult> {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return { ok: true, statusCode: res.status }
    const body = await res.text().catch(() => '')
    return { ok: false, statusCode: res.status, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
  }
}

export class StubSlackEngine implements SlackEngine {
  async send(_webhookUrl: string, _payload: SlackPayload): Promise<SlackResult> {
    return { ok: false, statusCode: 0, error: 'Stub: Slack integration not configured' }
  }
}

// ─── SSO/OIDC ─────────────────────────────────────────────────────────────────
// SSO is now handled by the dedicated sso module (oidc-provider.ts, sso.routes.ts).
// This interface is kept for backward compatibility but the actual implementation
// lives in src/modules/sso/oidc-provider.ts.

export interface SsoProvider {
  authenticate(code: string, tenantId: string): Promise<{ authenticated: boolean; userId: string | null }>
}

export class StubSsoProvider implements SsoProvider {
  async authenticate(_code: string, _tenantId: string): Promise<{ authenticated: boolean; userId: string | null }> {
    return { authenticated: false, userId: null }
  }
}

// ─── Payroll Partner ──────────────────────────────────────────────────────────

export interface PayrollPartner {
  submitPayroll(data: unknown): Promise<{ submitted: boolean; referenceId: string | null }>
}

export class StubPayrollPartner implements PayrollPartner {
  async submitPayroll(_data: unknown): Promise<{ submitted: boolean; referenceId: string | null }> {
    return { submitted: false, referenceId: null }
  }
}

// ─── Accounting Sync ──────────────────────────────────────────────────────────

export interface AccountingSync {
  syncJournalEntry(entry: unknown): Promise<{ synced: boolean; referenceId: string | null }>
}

export class StubAccountingSync implements AccountingSync {
  async syncJournalEntry(_entry: unknown): Promise<{ synced: boolean; referenceId: string | null }> {
    return { synced: false, referenceId: null }
  }
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

export interface CalendarIntegration {
  createEvent(event: unknown): Promise<{ created: boolean; eventId: string | null }>
}

export class StubCalendarIntegration implements CalendarIntegration {
  async createEvent(_event: unknown): Promise<{ created: boolean; eventId: string | null }> {
    return { created: false, eventId: null }
  }
}

// ─── Job Board Publisher ──────────────────────────────────────────────────────

export interface JobBoardPublisher {
  publishListing(listing: unknown): Promise<{ published: boolean; listingId: string | null }>
}

export class StubJobBoardPublisher implements JobBoardPublisher {
  async publishListing(_listing: unknown): Promise<{ published: boolean; listingId: string | null }> {
    return { published: false, listingId: null }
  }
}

// ─── Background Check / E-Signature ───────────────────────────────────────────

export interface VendorIntegration {
  initiateCheck(request: unknown): Promise<{ initiated: boolean; requestId: string | null }>
}

export class StubVendorIntegration implements VendorIntegration {
  async initiateCheck(_request: unknown): Promise<{ initiated: boolean; requestId: string | null }> {
    return { initiated: false, requestId: null }
  }
}
