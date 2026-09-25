'use client'

import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, uuid } from '@/lib/api'
import { useAuth } from '@/components/auth'
import { AppShell, RequireAuth } from '@/components/shell'
import { Alert, Badge, Button, Card, CardTitle, Input, Label, Select, Spinner } from '@/components/ui'

const STATUS_TONE = { approved: 'green', pending: 'amber', rejected: 'red', cancelled: 'slate' } as const

function LeaveWorkspace({ employeeId }: { employeeId: string }) {
  const queryClient = useQueryClient()
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [reason, setReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const leaveTypes = useQuery({ queryKey: ['leave-types'], queryFn: () => api.leaveTypes() })
  const requests = useQuery({ queryKey: ['leave-requests', 'mine'], queryFn: () => api.myLeaveRequests() })

  const submit = useMutation({
    mutationFn: (body: { leaveTypeId: string; startDate: string; endDate: string; reason?: string }) =>
      api.submitLeave(body, uuid()),
    onSuccess: (_, body) => {
      setFormError(null)
      setStartDate('')
      setEndDate('')
      setReason('')
      setLeaveTypeId(body.leaveTypeId)
      queryClient.invalidateQueries({ queryKey: ['leave-requests', 'mine'] })
      queryClient.invalidateQueries({ queryKey: ['balances', employeeId] })
    },
    onError: (err: unknown) => {
      setFormError(err instanceof Error && err.message ? err.message : 'Request failed.')
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!leaveTypeId || !startDate || !endDate) {
      setFormError('Leave type, start and end dates are required.')
      return
    }
    if (endDate < startDate) {
      setFormError('End date must be on or after the start date.')
      return
    }
    submit.mutate({ leaveTypeId, startDate, endDate, reason: reason || undefined })
  }

  const nameById = new Map(leaveTypes.data?.map((t) => [t.id, t.name] as const) ?? [])

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card>
        <CardTitle>Request time off</CardTitle>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label>Leave type</Label>
            <Select value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} required>
              <option value="" disabled>
                Select a type…
              </option>
              {leaveTypes.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start date</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
            </div>
            <div>
              <Label>End date</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
            </div>
          </div>
          <div>
            <Label>Reason (optional)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why?" />
          </div>
          {formError && <Alert>{formError}</Alert>}
          <Button type="submit" loading={submit.isPending}>
            Submit request
          </Button>
        </form>
      </Card>

      <Card>
        <CardTitle>My requests</CardTitle>
        {requests.isPending ? (
          <Spinner />
        ) : (requests.data ?? []).length === 0 ? (
          <p className="text-sm text-wine-soft">No requests yet.</p>
        ) : (
          <ul className="space-y-2">
            {(requests.data ?? []).map((r) => (
              <li key={r.id} className="rounded-lg bg-wine-tint px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-wine-ink">
                    {nameById.get(r.leaveTypeId) ?? 'Leave'} · {r.startDate} → {r.endDate}
                  </span>
                  <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-wine-soft">
                  <span>{r.daysRequested} day(s) requested</span>
                  {r.reason && <span className="truncate pl-4">{r.reason}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

export default function LeavePage() {
  const { me } = useAuth()

  return (
    <RequireAuth>
      <AppShell>
        <h1 className="mb-6 text-2xl font-semibold">Leave</h1>
        {me?.employeeId ? (
          <LeaveWorkspace employeeId={me.employeeId} />
        ) : (
          <Alert tone="amber">Your account has no linked employee record, so leave self-service is unavailable.</Alert>
        )}
      </AppShell>
    </RequireAuth>
  )
}