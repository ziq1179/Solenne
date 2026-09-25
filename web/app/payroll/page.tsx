'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Wallet } from 'lucide-react'
import { api, PAYROLL_RUN_LABELS, PAYROLL_RUN_STATUSES, PAYROLL_RUN_TONES, type PayrollRun } from '@/lib/api'
import { useAuth } from '@/components/auth'
import { AppShell, RequireAuth } from '@/components/shell'
import { Alert, Badge, Card, CardTitle, Spinner, Stat, fmtMoney, fmtPeriod, num } from '@/components/ui'

function employeeLabel(r: PayrollRun): string {
  return r.employeeCount == null ? '—' : String(r.employeeCount)
}

export default function PayrollPage() {
  const { me } = useAuth()
  const router = useRouter()
  const [statusFilter, setStatusFilter] = useState('')

  const canReadPayroll = me?.permissions.includes('payroll:read') ?? false

  const runs = useQuery({
    queryKey: ['payroll-runs', statusFilter],
    queryFn: () => api.payrollRuns({ status: statusFilter || undefined, pageSize: 50 }),
    enabled: canReadPayroll,
  })

  useEffect(() => {
    if (me && !canReadPayroll) router.replace('/payroll/my-payslips')
  }, [me, canReadPayroll, router])

  const items = runs.data?.data ?? []

  const totals = items.reduce(
    (acc, r) => {
      const gross = num(r.totalGross)
      const net = num(r.totalNet)
      if (gross != null) acc.gross += gross
      if (net != null) acc.net += net
      return acc
    },
    { gross: 0, net: 0 },
  )
  const currency = items[0]?.currency ?? 'USD'

  return (
    <RequireAuth>
      <AppShell>
        {!canReadPayroll ? (
          <Spinner label="Redirecting…" />
        ) : (
          <>
            <div className="mb-6 flex items-center justify-between">
              <h1 className="text-2xl font-semibold text-forest">Payroll</h1>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-lg border border-line bg-paper px-3 py-1.5 text-sm text-ink focus:border-forest focus:outline-none"
              >
                <option value="">All statuses</option>
                {PAYROLL_RUN_STATUSES.map((s) => (
                  <option key={s} value={s}>{PAYROLL_RUN_LABELS[s]}</option>
                ))}
              </select>
            </div>

            <div className="mb-5 grid gap-4 sm:grid-cols-3">
              <Stat label="Payroll runs" value={runs.data?.total ?? items.length} />
              <Stat label="Gross payroll" value={fmtMoney(totals.gross, currency)} className="border-forest-tint" />
              <Stat label="Net distributed" value={fmtMoney(totals.net, currency)} />
            </div>

            {runs.isPending ? (
              <Spinner />
            ) : runs.isError ? (
              <Alert>Failed to load payroll runs.</Alert>
            ) : items.length === 0 ? (
              <Card>
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <Wallet className="h-8 w-8 text-graphite-faint" />
                  <p className="text-sm text-graphite-soft">
                    {statusFilter ? 'No runs with that status.' : 'No payroll runs yet.'}
                  </p>
                </div>
              </Card>
            ) : (
              <Card>
                <CardTitle className="text-forest-soft">Payroll Runs</CardTitle>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-forest-soft">
                        <th className="pb-2 pr-4 font-medium">Period</th>
                        <th className="pb-2 pr-4 font-medium">Status</th>
                        <th className="pb-2 pr-4 font-medium">Gross</th>
                        <th className="pb-2 pr-4 font-medium">Deductions</th>
                        <th className="pb-2 pr-4 font-medium">Net</th>
                        <th className="pb-2 pr-4 font-medium">Employees</th>
                        <th className="pb-2 font-medium">Currency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((r: PayrollRun) => (
                        <tr key={r.id} className="border-b border-line/60 last:border-0">
                          <td className="py-2.5 pr-4">
                            <Link href={`/payroll/runs/${r.id}`} className="font-medium text-forest hover:underline">
                              {fmtPeriod(r.periodStart, r.periodEnd)}
                            </Link>
                          </td>
                          <td className="py-2.5 pr-4">
                            <Badge tone={PAYROLL_RUN_TONES[r.status] ?? 'slate'}>
                              {PAYROLL_RUN_LABELS[r.status] ?? r.status}
                            </Badge>
                          </td>
                          <td className="py-2.5 pr-4 tabular-nums text-graphite-soft">{fmtMoney(r.totalGross, r.currency)}</td>
                          <td className="py-2.5 pr-4 tabular-nums text-graphite-soft">{fmtMoney(r.totalDeductions, r.currency)}</td>
                          <td className="py-2.5 pr-4 font-medium tabular-nums text-ink">{fmtMoney(r.totalNet, r.currency)}</td>
                          <td className="py-2.5 pr-4 text-graphite-soft">{employeeLabel(r)}</td>
                          <td className="py-2.5 text-graphite-faint">{r.currency}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </>
        )}
      </AppShell>
    </RequireAuth>
  )
}