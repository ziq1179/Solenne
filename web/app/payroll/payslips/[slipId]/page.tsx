'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { api, PAYROLL_RUN_LABELS, PAYROLL_RUN_TONES } from '@/lib/api'
import { useAuth } from '@/components/auth'
import { AppShell, RequireAuth } from '@/components/shell'
import { PayslipStatement, employeeName } from '@/components/payslip-statement'
import { Alert, Badge, Card, CardTitle, Spinner, fmtDate, fmtPeriod } from '@/components/ui'

export default function PayslipDetailPage({ params }: { params: Promise<{ slipId: string }> }) {
  const { slipId } = use(params)
  const { me } = useAuth()

  const canReadPayroll = me?.permissions.includes('payroll:read') ?? false
  const canReadEmployees = me?.permissions.includes('employee:read') ?? false

  const slip = useQuery({
    queryKey: ['payslip', slipId],
    queryFn: () => api.payslip(slipId),
    enabled: canReadPayroll,
  })
  const runs = useQuery({
    queryKey: ['payroll-runs', 'all'],
    queryFn: () => api.payrollRuns({ pageSize: 100 }),
    enabled: canReadPayroll,
  })
  const directory = useQuery({
    queryKey: ['employees', 'directory'],
    queryFn: () => api.employees({ pageSize: 100 }),
    enabled: canReadEmployees,
  })

  const s = slip.data
  const run = (runs.data?.data ?? []).find((r) => r.id === s?.payrollRunId)
  const byId = new Map((directory.data?.data ?? []).map((e) => [e.id, e] as const))

  return (
    <RequireAuth>
      <AppShell>
        {!canReadPayroll ? (
          <Spinner label="Redirecting…" />
        ) : (
          <>
            {s && (
              <Link
                href={`/payroll/runs/${s.payrollRunId}`}
                className="mb-4 inline-flex items-center gap-1.5 text-sm text-forest hover:underline"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to payroll run
              </Link>
            )}

            {slip.isPending ? (
              <Spinner />
            ) : slip.isError ? (
              <Alert>Failed to load payslip.</Alert>
            ) : !s ? (
              <Alert>Payslip not found.</Alert>
            ) : (
              <div className="space-y-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-semibold text-forest">{employeeName(byId, s.employeeId)}</h1>
                    <p className="mt-1 text-sm text-graphite-soft">
                      {run ? `${fmtPeriod(run.periodStart, run.periodEnd)} · ${s.currency}` : `${s.currency} · Payslip`}
                    </p>
                  </div>
                  {run && (
                    <Badge tone={PAYROLL_RUN_TONES[run.status] ?? 'slate'}>
                      {PAYROLL_RUN_LABELS[run.status] ?? run.status}
                    </Badge>
                  )}
                </div>

                {!s.taxCompliant && (
                  <Alert tone="amber">
                    Provisional estimate — this payslip is calculated with the demo tax engine and is not tax compliant.
                  </Alert>
                )}

                <PayslipStatement slip={s} />

                <Card>
                  <CardTitle className="text-forest-soft">Details</CardTitle>
                  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    <div className="flex justify-between border-b border-line/60 py-1.5">
                      <dt className="text-graphite-soft">Payroll run</dt>
                      <dd className="break-all font-medium text-ink">{s.payrollRunId}</dd>
                    </div>
                    <div className="flex justify-between border-b border-line/60 py-1.5">
                      <dt className="text-graphite-soft">Payslip issued</dt>
                      <dd className="font-medium text-ink">{fmtDate(s.createdAt)}</dd>
                    </div>
                  </dl>
                </Card>
              </div>
            )}
          </>
        )}
      </AppShell>
    </RequireAuth>
  )
}