'use client'

import type { Payslip, EmployeeRecord } from '@/lib/api'
import { Card, CardTitle, fmtMoney } from './ui'

export function employeeName(map: Map<string, EmployeeRecord>, id: string): string {
  const e = map.get(id)
  if (!e) return id.slice(0, 8)
  return `${e.firstName} ${e.lastName}`
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={`flex items-baseline justify-between border-b border-line/60 px-1 py-1.5 last:border-0 ${
        strong ? 'border-line-dark' : ''
      }`}
    >
      <span className={strong ? 'text-sm font-medium text-forest' : 'text-sm text-graphite-soft'}>{label}</span>
      <span className={`text-sm font-medium tabular-nums ${strong ? 'text-forest' : 'text-ink'}`}>{value}</span>
    </div>
  )
}

export function PayslipStatement({ slip }: { slip: Payslip }) {
  const deductions = Array.isArray(slip.deductions) ? slip.deductions : []

  return (
    <Card>
      <CardTitle className="text-forest-soft">Pay statement</CardTitle>

      <div className="mb-5 rounded-lg bg-forest-tint p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-forest-ink">Net pay</div>
        <div className="mt-1 font-display text-3xl font-medium text-forest">{fmtMoney(slip.netPay, slip.currency)}</div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <CardTitle className="text-forest-soft">Earnings</CardTitle>
          <Line label="Base pay" value={fmtMoney(slip.basePay, slip.currency)} />
          <Line label="Overtime" value={fmtMoney(slip.overtimePay, slip.currency)} />
          <Line label="Bonus" value={fmtMoney(slip.bonus, slip.currency)} />
          <Line label="Other earnings" value={fmtMoney(slip.otherEarnings, slip.currency)} />
          <Line label="Gross pay" value={fmtMoney(slip.grossPay, slip.currency)} strong />
        </div>
        <div>
          <CardTitle className="text-forest-soft">Deductions</CardTitle>
          {deductions.length === 0 ? (
            <p className="px-1 py-1.5 text-sm text-graphite-soft">No deductions.</p>
          ) : (
            deductions.map((d, i) => <Line key={i} label={d.name} value={fmtMoney(d.amount, slip.currency)} />)
          )}
          <Line label="Total deductions" value={fmtMoney(slip.totalDeductions, slip.currency)} />
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-forest/40 px-4 py-3">
        <Line label="Net pay" value={fmtMoney(slip.netPay, slip.currency)} strong />
      </div>
    </Card>
  )
}