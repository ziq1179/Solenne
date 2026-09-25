'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth } from '@/components/auth'
import { AppShell, RequireAuth } from '@/components/shell'
import { Alert, Card, CardTitle, Input, Label, Spinner, Stat, fmtDuration } from '@/components/ui'

function monthBounds(): { from: string; to: string } {
  const d = new Date()
  const from = new Date(d.getFullYear(), d.getMonth(), 1)
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

export default function ReportsPage() {
  const { me } = useAuth()
  const canReport = me?.permissions.includes('reporting:read') ?? false

  const [from, setFrom] = useState(monthBounds().from)
  const [to, setTo] = useState(monthBounds().to)
  const [year, setYear] = useState(String(new Date().getFullYear()))

  const headcount = useQuery({ queryKey: ['headcount'], queryFn: () => api.headcount(), enabled: canReport })
  const attendance = useQuery({
    queryKey: ['attendance-summary', from, to],
    queryFn: () => api.attendanceSummary(from, to),
    enabled: canReport,
  })
  const leave = useQuery({ queryKey: ['leave-summary', year], queryFn: () => api.leaveSummary(Number(year)), enabled: canReport })

  return (
    <RequireAuth>
      <AppShell>
        <h1 className="mb-6 text-2xl font-semibold text-plum">Reports</h1>

        {!canReport ? (
          <Alert tone="amber">
            Reporting is restricted to admins and HR managers. If you believe this is a mistake, contact your tenant admin.
          </Alert>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-5 md:grid-cols-3">
              {headcount.isPending ? (
                <Spinner />
              ) : headcount.data ? (
                <>
                  <Stat label="Total employees" value={headcount.data.total} className="border-plum-tint" />
                  <Card>
                    <CardTitle className="text-plum-soft">By department</CardTitle>
                    <ul className="space-y-1.5">
                      {headcount.data.byDepartment.map((r) => (
                        <li key={r.name} className="flex justify-between text-sm">
                          <span className="text-slate-300">{r.name}</span>
                          <span className="text-slate-500">{r.count}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                  <Card>
                    <CardTitle className="text-plum-soft">By location</CardTitle>
                    <ul className="space-y-1.5">
                      {headcount.data.byLocation.map((r) => (
                        <li key={r.name} className="flex justify-between text-sm">
                          <span className="text-slate-300">{r.name}</span>
                          <span className="text-slate-500">{r.count}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                </>
              ) : (
                <Alert>Failed to load headcount.</Alert>
              )}
            </div>

            <Card>
              <CardTitle className="text-plum-soft">Attendance summary</CardTitle>
              <div className="mb-4 flex flex-wrap gap-3">
                <div>
                  <Label>From</Label>
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />
                </div>
                <div>
                  <Label>To</Label>
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-44" />
                </div>
              </div>
              {attendance.isPending ? (
                <Spinner />
              ) : attendance.data && attendance.data.rows.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-plum-soft">
                        <th className="pb-2 pr-4 font-medium">Employee</th>
                        <th className="pb-2 pr-4 font-medium">Department</th>
                        <th className="pb-2 pr-4 font-medium">Clock-ins</th>
                        <th className="pb-2 font-medium">Total time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attendance.data.rows
                        .slice()
                        .sort((a, b) => b.totalMinutes - a.totalMinutes)
                        .map((r) => (
                          <tr key={r.employeeId} className="border-b border-slate-800/60 last:border-0">
                            <td className="py-2 pr-4 text-slate-200">
                              {r.firstName} {r.lastName}{' '}
                              <span className="text-xs text-slate-500">#{r.employeeNumber}</span>
                            </td>
                            <td className="py-2 pr-4 text-slate-400">{r.departmentName ?? '—'}</td>
                            <td className="py-2 pr-4 text-slate-400">{r.clockIns}</td>
                            <td className="py-2 text-slate-400">{fmtDuration(r.totalMinutes)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {attendance.data.totalEmployees > attendance.data.rows.length && (
                    <p className="mt-2 text-xs text-slate-500">
                      Summarizing {attendance.data.rows.length} of {attendance.data.totalEmployees} employees with activity in
                      this range.
                    </p>
                  )}
                </div>
              ) : (
                <Alert tone="sky">No attendance in this range.</Alert>
              )}
            </Card>

            <Card>
              <CardTitle className="text-plum-soft">Leave summary</CardTitle>
              <div className="mb-4 flex items-end gap-3">
                <div>
                  <Label>Year</Label>
                  <Input type="number" value={year} onChange={(e) => setYear(e.target.value)} className="w-32" min={2020} max={2035} />
                </div>
              </div>
              {leave.isPending ? (
                <Spinner />
              ) : leave.data && leave.data.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-plum-soft">
                        <th className="pb-2 pr-4 font-medium">Employee</th>
                        <th className="pb-2 pr-4 font-medium">Type</th>
                        <th className="pb-2 pr-4 font-medium">Accrued</th>
                        <th className="pb-2 pr-4 font-medium">Used</th>
                        <th className="pb-2 font-medium">Carried over</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leave.data.map((r) =>
                        r.balances.map((b) => (
                          <tr
                            key={`${r.employeeId}-${b.leaveTypeId}`}
                            className="border-b border-slate-800/60 last:border-0"
                          >
                            <td className="py-2 pr-4 text-slate-200">
                              {r.firstName} {r.lastName}{' '}
                              <span className="text-xs text-slate-500">#{r.employeeNumber}</span>
                            </td>
                            <td className="py-2 pr-4 text-slate-400">{b.leaveTypeName}</td>
                            <td className="py-2 pr-4 text-slate-400">{b.accruedDays}</td>
                            <td className="py-2 pr-4 text-slate-400">{b.usedDays}</td>
                            <td className="py-2 text-slate-400">{b.carriedOverDays}</td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Alert tone="sky">No leave balances for {year}.</Alert>
              )}
            </Card>
          </div>
        )}
      </AppShell>
    </RequireAuth>
  )
}