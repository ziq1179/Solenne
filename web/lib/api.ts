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
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}