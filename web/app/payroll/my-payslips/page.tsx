'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ReceiptText } from 'lucide-react'
import { api } from '@/lib/api'
import { AppShell, RequireAuth } from '@/components/shell'
import { PayslipStatement } from '@/components/payslip-statement'
import { Alert, Badge, Card, CardTitle, Spinner, fmtMoney } from '@/components/ui'

function issuedLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function MyPayslipsPage() {
  const [expanded, setExpanded] = useState<string | null>(null)

  const payslips = useQuery({
    queryKey: ['my-payslips'],
    queryFn: () => api.myPayslips(),
  })

  const items = payslips.data ?? []

  return (
    <RequireAuth>
      <AppShell>
        <h1 className="mb-6 text-2xl font-semibold text-forest">My Payslips</h1>

        {payslips.isPending ? (
          <Spinner />
        ) : payslips.isError ? (
          <Alert>Failed to load payslips.</Alert>
        ) : items.length === 0 ? (
          <Card>
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <ReceiptText className="h-8 w-8 text-graphite-faint" />
              <p className="text-sm text-graphite-soft">No payslips yet. Payslips appear here after a payroll run is paid.</p>
            </div>
          </Card>
        ) : (
          <div className="space-y-4">
            {items.map((s) => {
              const open = expanded === s.id
              return (
                <Card key={s.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : s.id)}
                    className="flex w-full items-center justify-between gap-4 text-left"
                  >
                    <div className="flex items-center gap-3">
                      {open ? (
                        <ChevronDown className="h-4 w-4 text-forest" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-forest" />
                      )}
                      <div>
                        <div className="text-sm font-medium text-ink">Payslip · {issuedLabel(s.createdAt)}</div>
                        <div className="text-xs text-graphite-soft">{s.currency}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <div className="font-display text-lg font-medium text-forest">{fmtMoney(s.netPay, s.currency)}</div>
                        <div className="text-xs text-graphite-faint">net pay</div>
                      </div>
                      <Badge tone={s.taxCompliant ? 'green' : 'amber'}>{s.taxCompliant ? 'Compliant' : 'Provisional'}</Badge>
                    </div>
                  </button>
                  {open && (
                    <div className="mt-4">
                      <PayslipStatement slip={s} />
                    </div>
                  )}
                </Card>
              )
            })}
          </div>
        )}
      </AppShell>
    </RequireAuth>
  )
}