'use client'

export interface Me {
  id: string
  email: string
  employeeId: string | null
  roles: string[]
  permissions: string[]
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export interface SignupInput {
  companyName: string
  subdomain: string
  adminEmail: string
  adminPassword: string
  adminFirstName: string
  adminLastName: string
}

export interface SignupResult extends TokenPair {
  tenant: { id: string; name: string; subdomain: string; plan: string }
}

export interface LeaveType {
  id: string
  name: string
  accrualDaysPerYear: number
  carryForwardMaxDays: number
  requiresApproval: boolean
}

export interface Balance {
  leaveTypeId: string
  year: number
  accruedDays: number
  usedDays: number
  carriedOverDays: number
  remainingDays: number
}

export interface LeaveRequest {
  id: string
  employeeId: string
  leaveTypeId: string
  startDate: string
  endDate: string
  daysRequested: number
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  reason: string | null
  submittedVia: 'web' | 'mobile' | 'ai_agent'
  createdAt: string
}

export interface AttendanceRecord {
  id: string
  employeeId: string
  clockInAt: string
  clockOutAt: string | null
  totalMinutes: number | null
}

export interface CountByName {
  id: string | null
  name: string | null
  count: number
}

export interface HeadcountReport {
  total: number
  byDepartment: CountByName[]
  byLocation: (CountByName & { country: string | null })[]
  byEmploymentType: { employmentType: string; count: number }[]
}

export interface AttendanceSummaryRow {
  employeeId: string
  employeeNumber: string
  firstName: string
  lastName: string
  departmentName: string | null
  clockIns: number
  totalMinutes: number
}

export interface AttendanceSummary {
  totalEmployees: number
  totalClockIns: number
  totalMinutes: number
  rows: AttendanceSummaryRow[]
}

export interface LeaveSummaryRow {
  employeeId: string
  employeeNumber: string
  firstName: string
  lastName: string
  balances: {
    leaveTypeId: string
    leaveTypeName: string
    accruedDays: number
    usedDays: number
    carriedOverDays: number
    remainingDays: number
  }[]
}

export interface LeaveTypeBalanceRow {
  leaveTypeId: string
  leaveTypeName: string
  accruedDays: number
  usedDays: number
  carriedOverDays: number
  remainingDays: number
}

/* ── Notifications ──────────────────────────────────────────────────────── */

export interface Notification {
  id: string
  type: string
  title: string
  body: string | null
  entityType: string
  entityId: string
  isRead: boolean
  createdAt: string
}

/* ── Billing ────────────────────────────────────────────────────────────── */

export interface Subscription {
  id: string
  tenantId: string
  plan: string
  status: string
  trialEndsAt: string | null
  currentPeriodStart: string
  currentPeriodEnd: string
  seatLimit: number
  seatsUsed: number
}

export interface UsageRow {
  metric: string
  total: number
  lastAt: string | null
}

export const PLAN_NAMES: Record<string, string> = {
  trial: 'Trial',
  core: 'Core',
  grow: 'Grow',
  enterprise: 'Enterprise',
}

export const PLAN_SEAT_LIMITS: Record<string, number> = {
  trial: 5,
  core: 25,
  grow: 100,
  enterprise: 1000,
}

/* ── ATS / Recruitment ──────────────────────────────────────────────────── */

export interface JobOpening {
  id: string
  title: string
  departmentId: string | null
  departmentName: string | null
  locationId: string | null
  locationName: string | null
  employmentType: string
  salaryMin: string | null
  salaryMax: string | null
  currency: string
  description: string | null
  requirements: string | null
  headcount: number
  status: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface Candidate {
  id: string
  jobOpeningId: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  resumeText: string | null
  source: string
  stage: string
  rating: number | null
  notes: string | null
  hiredEmployeeId: string | null
  createdAt: string
  updatedAt: string
}

export const JOB_STATUSES = ['draft', 'pending_approval', 'open', 'on_hold', 'closed'] as const
export const PIPELINE_STAGES = ['sourced', 'applied', 'screening', 'interview', 'offer', 'hired', 'rejected'] as const

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'https://backend-liard-chi-84.vercel.app'
const ACCESS_KEY = 'solenne.access'
const REFRESH_KEY = 'solenne.refresh'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail: unknown,
  ) {
    super(`${status} ${code}`)
    this.name = 'ApiError'
  }
}

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(ACCESS_KEY)
}

export function setTokens(pair: TokenPair): void {
  window.localStorage.setItem(ACCESS_KEY, pair.accessToken)
  window.localStorage.setItem(REFRESH_KEY, pair.refreshToken)
}

export function clearTokens(): void {
  window.localStorage.removeItem(ACCESS_KEY)
  window.localStorage.removeItem(REFRESH_KEY)
}

let refreshing: Promise<boolean> | null = null

/** Rotates the stored refresh token. Concurrent 401s share one refresh. */
export function refreshTokens(): Promise<boolean> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const refreshToken = window.localStorage.getItem(REFRESH_KEY)
    if (!refreshToken) return false
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })
      if (!res.ok) return false
      setTokens((await res.json()) as TokenPair)
      return true
    } catch {
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

async function request<T>(
  path: string,
  init: RequestInit,
  withAuth: boolean,
  allowRetry: boolean,
): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (withAuth) {
    const token = getAccessToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
  }

  const res = await fetch(`${API_URL}${path}`, { ...init, headers })

  if (res.status === 401 && withAuth && allowRetry) {
    if (await refreshTokens()) return request<T>(path, init, withAuth, false)
    clearTokens()
  }

  if (!res.ok) {
    let payload: unknown = null
    try {
      payload = await res.json()
    } catch {
      // non-JSON error body
    }
    const err = payload as { error?: { code?: string; message?: string; details?: unknown } } | null
    throw new ApiError(res.status, err?.error?.code ?? 'HTTP_ERROR', err?.error?.message ?? err?.error?.details ?? null)
  }

  if (res.status === 204) return undefined as unknown as T
  return res.json() as Promise<T>
}

export const api = {
  login: (body: { email: string; password: string; tenantSubdomain: string }) =>
    request<TokenPair>('/auth/login', { method: 'POST', body: JSON.stringify(body) }, false, false),

  signup: (body: SignupInput) =>
    request<SignupResult>('/tenants/signup', { method: 'POST', body: JSON.stringify(body) }, false, false),

  me: () => request<Me>('/auth/me', { method: 'GET' }, true, true),

  leaveTypes: () => request<LeaveType[]>('/leave-types', { method: 'GET' }, true, true),

  balances: (employeeId: string, year = new Date().getFullYear()) =>
    request<Balance[]>(`/employees/${employeeId}/leave-balances?year=${year}`, { method: 'GET' }, true, true),

  attendance: (employeeId: string) =>
    request<AttendanceRecord[]>(`/employees/${employeeId}/attendance`, { method: 'GET' }, true, true),

  clockIn: (idempotencyKey: string) =>
    request<AttendanceRecord>(
      '/attendance/clock-in',
      { method: 'POST', body: JSON.stringify({ source: 'web' }), headers: { 'Idempotency-Key': idempotencyKey } },
      true,
      true,
    ),

  clockOut: (idempotencyKey: string) =>
    request<AttendanceRecord>(
      '/attendance/clock-out',
      { method: 'POST', body: JSON.stringify({}), headers: { 'Idempotency-Key': idempotencyKey } },
      true,
      true,
    ),

  myLeaveRequests: () =>
    request<LeaveRequest[]>('/leave-requests', { method: 'GET' }, true, true),

  submitLeave: (body: { leaveTypeId: string; startDate: string; endDate: string; reason?: string }, idempotencyKey: string) =>
    request<LeaveRequest>(
      '/leave-requests',
      { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': idempotencyKey } },
      true,
      true,
    ),

  headcount: (status = 'active') =>
    request<HeadcountReport>(`/reports/headcount?status=${status}`, { method: 'GET' }, true, true),

  attendanceSummary: (from: string, to: string) =>
    request<AttendanceSummary>(`/reports/attendance-summary?from=${from}&to=${to}`, { method: 'GET' }, true, true),

  leaveSummary: (year = new Date().getFullYear()) =>
    request<LeaveSummaryRow[]>(`/reports/leave-summary?year=${year}`, { method: 'GET' }, true, true),

  /* ── Notifications ────────────────────────────────────────────────────── */

  notifications: (opts?: { unread?: boolean; type?: string; page?: number; pageSize?: number }) => {
    const p = new URLSearchParams()
    if (opts?.unread) p.set('unread', 'true')
    if (opts?.type) p.set('type', opts.type)
    if (opts?.page) p.set('page', String(opts.page))
    if (opts?.pageSize) p.set('pageSize', String(opts.pageSize))
    const qs = p.toString()
    return request<{ data: Notification[]; page: number; pageSize: number; total: number }>(
      `/notifications${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      true,
      true,
    )
  },

  unreadCount: () => request<{ n: number }>('/notifications/unread-count', { method: 'GET' }, true, true),

  markRead: (notificationId: string) =>
    request<{ id: string }>(`/notifications/${notificationId}/read`, { method: 'PATCH' }, true, true),

  markAllRead: () =>
    request<{ updated: number }>('/notifications/read-all', { method: 'POST' }, true, true),

  /* ── Billing ──────────────────────────────────────────────────────────── */

  subscription: () => request<Subscription>('/billing/subscription', { method: 'GET' }, true, true),

  setPlan: (plan: string) =>
    request<Subscription>('/billing/subscription/plan', { method: 'PATCH', body: JSON.stringify({ plan }) }, true, true),

  usage: (opts?: { metric?: string; from?: string; to?: string }) => {
    const p = new URLSearchParams()
    if (opts?.metric) p.set('metric', opts.metric)
    if (opts?.from) p.set('from', opts.from)
    if (opts?.to) p.set('to', opts.to)
    const qs = p.toString()
    return request<UsageRow[]>(`/billing/usage${qs ? `?${qs}` : ''}`, { method: 'GET' }, true, true)
  },

  /* ── ATS / Recruitment ────────────────────────────────────────────────── */

  jobOpenings: (opts?: { status?: string; departmentId?: string; page?: number; pageSize?: number }) => {
    const p = new URLSearchParams()
    if (opts?.status) p.set('status', opts.status)
    if (opts?.departmentId) p.set('departmentId', opts.departmentId)
    if (opts?.page) p.set('page', String(opts.page))
    if (opts?.pageSize) p.set('pageSize', String(opts.pageSize))
    const qs = p.toString()
    return request<{ data: JobOpening[]; page: number; pageSize: number; total: number }>(
      `/job-openings${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      true,
      true,
    )
  },

  createJobOpening: (body: Record<string, unknown>, idempotencyKey: string) =>
    request<JobOpening>(
      '/job-openings',
      { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': idempotencyKey } },
      true,
      true,
    ),

  jobOpening: (jobId: string) =>
    request<JobOpening>(`/job-openings/${jobId}`, { method: 'GET' }, true, true),

  candidates: (jobId: string, opts?: { stage?: string; page?: number; pageSize?: number }) => {
    const p = new URLSearchParams()
    if (opts?.stage) p.set('stage', opts.stage)
    if (opts?.page) p.set('page', String(opts.page))
    if (opts?.pageSize) p.set('pageSize', String(opts.pageSize))
    const qs = p.toString()
    return request<{ data: Candidate[]; page: number; pageSize: number; total: number }>(
      `/job-openings/${jobId}/candidates${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      true,
      true,
    )
  },

  candidate: (candidateId: string) =>
    request<Candidate>(`/candidates/${candidateId}`, { method: 'GET' }, true, true),

  transitionCandidate: (candidateId: string, stage: string) =>
    request<Candidate>(
      `/candidates/${candidateId}/transition`,
      { method: 'POST', body: JSON.stringify({ stage }) },
      true,
      true,
    ),

  /* ── AI Agent ──────────────────────────────────────────────────────────── */

  chat: (body: { message: string; conversationId?: string }) =>
    request<{ reply: string; conversationId: string; toolCalls: unknown[] }>(
      '/ai/chat',
      { method: 'POST', body: JSON.stringify(body) },
      true,
      true,
    ),

  searchPolicy: (query: string) =>
    request<{ results: { content: string; document_title: string; similarity: number }[] }>(
      '/ai/search-policy',
      { method: 'POST', body: JSON.stringify({ query }) },
      true,
      true,
    ),
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}