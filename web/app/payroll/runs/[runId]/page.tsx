'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { ArrowLeft, ReceiptText } from 'lucide-react'
import { api, PAYROLL_RUN_LABELS, PAYROLL_RUN_TONES, type EmployeeRecord } from '@/lib/api'
import { useAuth } from '@/components/auth'
import { AppShell, RequireAuth } from '@/components/shell'
import { employeeName } from '@/components/payslip-statement'
import { Alert, Badge, Card, CardTitle, Spinner, Stat, fmtMoney, fmtPeriod } from '@/components/ui'

export default function PayrollRunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params)
  const { me } = useAuth()

  const canReadPayroll = me?.permissions.includes('payroll:read') ?? false
  const canReadEmployees = me?.permissions.includes('employee:read') ?? false

  const runs = useQuery({
    queryKey: ['payroll-runs', 'all'],
    queryFn: () => api.payrollRuns({ pageSize: 100 }),
    enabled: canReadPayroll,
  })
  const payslips = useQuery({
    queryKey: ['payroll-run-payslips', runId],
    queryFn: () => api.payrollRunPayslips(runId),
    enabled: canReadPayroll,
  })
  const directory = useQuery({
    queryKey: ['employees', 'directory'],
    queryFn: () => api.employees({ pageSize: 100 }),
    enabled: canReadEmployees,
  })

  const run = (runs.data?.data ?? []).find((r) => r.id === runId)
  const byId = new Map((directory.data?.data ?? []).map((e) => [e.id, e] as const))
  const items = payslips.data ?? []

  return (
    <RequireAuth>
      <AppShell>
        {!canReadPayroll ? (
          <Spinner label="Redirecting…" />
        ) : (
          <>
            <Link href="/payroll" className="mb-4 inline-flex items-center gap-1.5 text-sm text-forest hover:underline">
              <ArrowLeft className="h-4 w-4" />
              All payroll runs
            </Link>

            {runs.isPending || payslips.isPending ? (
              <Spinner />
            ) : runs.isError || payslips.isError ? (
              <Alert>Failed to load payroll run.</Alert>
            ) : !run ? (
              <Alert>Payroll run not found.</Alert>
            ) : (
              <div className="space-y-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-semibold text-forest">{fmtPeriod(run.periodStart, run.periodEnd)}</h1>
                    <p className="mt-1 text-sm text-graphite-soft">
                      {run.currency} · {run.notes ?? 'Payroll run'}
                    </p>
                  </div>
                  <Badge tone={PAYROLL_RUN_TONES[run.status] ?? 'slate'}>
                    {PAYROLL_RUN_LABELS[run.status] ?? run.status}
                  </Badge>
                </div>

                <div className="grid gap-4 sm:grid-cols-4">
                  <Stat label="Net total" value={fmtMoney(run.totalNet, run.currency)} className="border-forest-tint" />
                  <Stat label="Gross total" value={fmtMoney(run.totalGross, run.currency)} />
                  <Stat label="Deductions" value={fmtMoney(run.totalDeductions, run.currency)} />
                  <Stat label="Employees" value={run.employeeCount == null ? '—' : String(run.employeeCount)} />
                </div>

                {items.length === 0 ? (
                  <Card>
                    <div className="flex flex-col items-center gap-3 py-8 text-center">
                      <ReceiptText className="h-8 w-8 text-graphite-faint" />
                      <p className="text-sm text-graphite-soft">
                        {run.status === 'draft' ? 'This run has not been calculated yet.' : 'No payslips in this run.'}
                      </p>
                    </div>
                  </Card>
                ) : (
                  <Card>
                    <CardTitle className="text-forest-soft">Payslips</CardTitle>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-forest-soft">
                            <th className="pb-2 pr-4 font-medium">Employee</th>
                            <th className="pb-2 pr-4 font-medium">Gross</th>
                            <th className="pb-2 pr-4 font-medium">Deductions</th>
                            <th className="pb-2 pr-4 font-medium">Net</th>
                            <th className="pb-2 font-medium">Tax</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((s) => (
                            <tr key={s.id} className="border-b border-line/60 last:border-0">
                              <td className="py-2.5 pr-4">
                                <Link href={`/payroll/payslips/${s.id}`} className="font-medium text-forest hover:underline">
                                  {employeeName(byId, s.employeeId)}
                                </Link>
                              </td>
                              <td className="py-2.5 pr-4 tabular-nums text-graphite-soft">{fmtMoney(s.grossPay, s.currency)}</td>
                              <td className="py-2.5 pr-4 tabular-nums text-graphite-soft">{fmtMoney(s.totalDeductions, s.currency)}</td>
                              <td className="py-2.5 pr-4 font-medium tabular-nums text-ink">{fmtMoney(s.netPay, s.currency)}</td>
                              <td className="py-2.5">
                                <Badge tone={s.taxCompliant ? 'green' : 'amber'}>{s.taxCompliant ? 'Compliant' : 'Provisional'}</Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </div>
            )}
          </>
        )}
      </AppShell>
    </RequireAuth>
  )
}