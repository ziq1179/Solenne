'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { LogIn, LogOut, Plane } from 'lucide-react'
import { api, uuid, type AttendanceRecord } from '@/lib/api'
import { useAuth } from '@/components/auth'
import { AppShell, RequireAuth } from '@/components/shell'
import { Alert, Badge, Button, Card, CardTitle, Spinner, fmtDate, fmtDuration } from '@/components/ui'

const STATUS_TONE = { approved: 'green', pending: 'amber', rejected: 'red', cancelled: 'slate' } as const

function ClockCard() {
  const { me } = useAuth()
  const queryClient = useQueryClient()
  const employeeId = me!.employeeId!

  const attendance = useQuery({ queryKey: ['attendance', employeeId], queryFn: () => api.attendance(employeeId) })
  const open = (attendance.data ?? []).find((r: AttendanceRecord) => r.clockOutAt === null)

  const clock = useMutation({
    mutationFn: async (action: 'in' | 'out') => {
      const key = uuid()
      return action === 'in' ? api.clockIn(key) : api.clockOut(key)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendance', employeeId] })
    },
  })

  if (attendance.isPending) return <Spinner />
  if (attendance.isError)
    return <Alert>Failed to load attendance.</Alert>

  return (
    <Card>
      <CardTitle>Time clock</CardTitle>
      <div className="flex flex-col items-start gap-4">
        {open ? (
          <>
            <div className="flex items-center gap-2">
              <Badge tone="green">● Clocked in</Badge>
              <span className="text-sm text-slate-400">since {fmtDate(open.clockInAt)}</span>
            </div>
            <Button
              variant="danger"
              loading={clock.isPending}
              onClick={() => clock.mutate('out')}
              className="w-full sm:w-auto"
            >
              <LogOut className="h-4 w-4" />
              Clock out
            </Button>
          </>
        ) : (
          <>
            <Badge tone="slate">○ Not clocked in</Badge>
            <Button
              loading={clock.isPending}
              onClick={() => clock.mutate('in')}
              className="w-full sm:w-auto"
            >
              <LogIn className="h-4 w-4" />
              Clock in
            </Button>
          </>
        )}
        {clock.isError && <Alert>A clock {open ? 'out' : 'in'} failed — try again.</Alert>}
      </div>
    </Card>
  )
}

function BalancesCard() {
  const { me } = useAuth()
  const employeeId = me!.employeeId!

  const leaveTypes = useQuery({ queryKey: ['leave-types'], queryFn: () => api.leaveTypes() })
  const balances = useQuery({ queryKey: ['balances', employeeId], queryFn: () => api.balances(employeeId) })

  if (balances.isPending || leaveTypes.isPending) return <Spinner />
  if (balances.isError || leaveTypes.isError) return <Alert>Failed to load leave balances.</Alert>

  const nameById = new Map(leaveTypes.data.map((t) => [t.id, t.name] as const))

  return (
    <Card>
      <CardTitle>Leave balances</CardTitle>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="pb-2 pr-4 font-medium">Type</th>
              <th className="pb-2 pr-4 font-medium">Accrued</th>
              <th className="pb-2 pr-4 font-medium">Used</th>
              <th className="pb-2 font-medium">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {balances.data.map((b) => (
              <tr key={b.leaveTypeId} className="border-b border-slate-800/60 last:border-0">
                <td className="py-2 pr-4 text-slate-200">{nameById.get(b.leaveTypeId) ?? 'Leave'}</td>
                <td className="py-2 pr-4 text-slate-400">{b.accruedDays}</td>
                <td className="py-2 pr-4 text-slate-400">{b.usedDays}</td>
                <td className="py-2 font-medium text-cobalt">{b.remainingDays}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function HistoryCard() {
  const { me } = useAuth()
  const employeeId = me!.employeeId!

  const attendance = useQuery({ queryKey: ['attendance', employeeId], queryFn: () => api.attendance(employeeId) })

  if (attendance.isPending) return <Spinner />
  if (attendance.isError) return <Alert>Failed to load attendance.</Alert>
  if (attendance.data.length === 0) return <Card><CardTitle>Attendance</CardTitle><p className="text-sm text-slate-500">No records yet — clock in to get started.</p></Card>

  return (
    <Card>
      <CardTitle>Recent attendance</CardTitle>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="pb-2 pr-4 font-medium">Clock in</th>
              <th className="pb-2 pr-4 font-medium">Clock out</th>
              <th className="pb-2 font-medium">Duration</th>
            </tr>
          </thead>
          <tbody>
            {attendance.data.slice(0, 8).map((r) => (
              <tr key={r.id} className="border-b border-slate-800/60 last:border-0">
                <td className="py-2 pr-4 text-slate-200">{fmtDate(r.clockInAt)}</td>
                <td className="py-2 pr-4 text-slate-400">{r.clockOutAt ? fmtDate(r.clockOutAt) : <Badge tone="green">open</Badge>}</td>
                <td className="py-2 text-slate-400">{fmtDuration(r.totalMinutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function RequestsCard() {
  const requests = useQuery({ queryKey: ['leave-requests', 'mine'], queryFn: () => api.myLeaveRequests() })
  const leaveTypes = useQuery({ queryKey: ['leave-types'], queryFn: () => api.leaveTypes() })

  if (requests.isPending || leaveTypes.isPending) return <Spinner />
  if (requests.isError || leaveTypes.isError) return <Alert>Failed to load leave requests.</Alert>

  const nameById = new Map(leaveTypes.data.map((t) => [t.id, t.name] as const))

  return (
    <Card>
      <CardTitle>Recent leave requests</CardTitle>
      {requests.data.length === 0 ? (
        <p className="text-sm text-slate-500">No requests yet.</p>
      ) : (
        <ul className="space-y-2">
          {requests.data.slice(0, 5).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg bg-cobalt-tint px-3 py-2">
              <div className="flex items-center gap-2">
                <Plane className="h-4 w-4 text-cobalt" />
                <span className="text-sm text-cobalt-ink">
                  {nameById.get(r.leaveTypeId) ?? 'Leave'} · {r.startDate} → {r.endDate}
                </span>
              </div>
              <div className="text-sm">
                {r.daysRequested}d{' '}
                <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export default function DashboardPage() {
  const { me } = useAuth()
  if (!me) return null
  const employeeId = me.employeeId

  return (
    <RequireAuth>
      <AppShell>
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-slate-500">Welcome back{employeeId ? '' : ' — no employee record linked to this account yet'}.</p>
        </div>

        {employeeId ? (
          <div className="grid gap-5 md:grid-cols-3">
            <ClockCard />
            <BalancesCard />
            <RequestsCard />
            <div className="md:col-span-3">
              <HistoryCard />
            </div>
          </div>
        ) : (
          <Alert tone="amber">Your account has no linked employee record, so self-service (clock-in/out, leave balances) is unavailable.</Alert>
        )}
      </AppShell>
    </RequireAuth>
  )
}