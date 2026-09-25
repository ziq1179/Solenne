'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CreditCard, Users, TrendingUp } from 'lucide-react'
import { api, PLAN_NAMES, PLAN_SEAT_LIMITS, type Subscription, type UsageRow } from '@/lib/api'
import { useAuth } from '@/components/auth'
import { AppShell, RequireAuth } from '@/components/shell'
import { Alert, Badge, Button, Card, CardTitle, Select, Spinner } from '@/components/ui'

const PLAN_ORDER = ['trial', 'core', 'grow', 'enterprise']

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function SubscriptionCard({ sub, isAdmin, onPlanChange }: { sub: Subscription; isAdmin: boolean; onPlanChange: (plan: string) => void }) {
  const usagePct = sub.seatLimit > 0 ? Math.round((sub.seatsUsed / sub.seatLimit) * 100) : 0

  return (
            <Card>
              <CardTitle className="text-bronze-ink">Subscription</CardTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg bg-bronze-tint p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-bronze-ink">Current plan</div>
          <div className="mt-1 font-display text-2xl font-medium text-bronze">
            {PLAN_NAMES[sub.plan] ?? sub.plan}
          </div>
          <div className="mt-1 text-xs text-bronze-ink">
            {sub.status === 'active' ? 'Active' : sub.status}
            {sub.trialEndsAt && ` — trial ends ${fmtDate(sub.trialEndsAt)}`}
          </div>
        </div>
        <div className="rounded-lg bg-paper-dim p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-graphite-soft">Seats</div>
          <div className="mt-1 font-display text-2xl font-medium text-ink">
            {sub.seatsUsed} / {sub.seatLimit}
          </div>
          <div className="mt-1 text-xs text-graphite-faint">{usagePct}% used</div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between text-xs text-graphite-faint">
        <span>Period: {fmtDate(sub.currentPeriodStart)} — {fmtDate(sub.currentPeriodEnd)}</span>
      </div>
      {isAdmin && (
        <div className="mt-4 flex items-center gap-3">
          <span className="text-sm text-graphite-soft">Change plan:</span>
          {PLAN_ORDER.filter((p) => p !== sub.plan).map((p) => (
            <Button
              key={p}
              variant="outline"
              onClick={() => onPlanChange(p)}
              className="text-xs"
            >
              {PLAN_NAMES[p]}
            </Button>
          ))}
        </div>
      )}
    </Card>
  )
}

function UsageCard({ usage }: { usage: UsageRow[] }) {
  return (
    <Card>
      <CardTitle className="text-bronze-ink">Usage this period</CardTitle>
      {usage.length === 0 ? (
        <p className="text-sm text-graphite-soft">No usage data.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-bronze-ink">
                <th className="pb-2 pr-4 font-medium">Metric</th>
                <th className="pb-2 pr-4 font-medium">Total</th>
                <th className="pb-2 font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((r) => (
                <tr key={r.metric} className="border-b border-line/60 last:border-0">
                  <td className="py-2 pr-4 font-medium text-ink">{r.metric.replace(/_/g, ' ')}</td>
                  <td className="py-2 pr-4 text-graphite-soft">{r.total}</td>
                  <td className="py-2 text-graphite-faint">{r.lastAt ? fmtDate(r.lastAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export default function BillingPage() {
  const { me } = useAuth()
  const queryClient = useQueryClient()
  const isAdmin = me?.permissions.includes('billing:write') ?? false

  const sub = useQuery({ queryKey: ['billing-subscription'], queryFn: () => api.subscription(), enabled: !!me })
  const usage = useQuery({ queryKey: ['billing-usage'], queryFn: () => api.usage(), enabled: !!me })

  const setPlan = useMutation({
    mutationFn: (plan: string) => api.setPlan(plan),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['billing-subscription'] })
    },
  })

  const canBilling = me?.permissions.includes('billing:read') ?? false

  return (
    <RequireAuth>
      <AppShell>
        <h1 className="mb-6 text-2xl font-semibold text-bronze">Billing</h1>

        {!canBilling ? (
          <Alert tone="amber">
            Billing is restricted to admins and HR managers.
          </Alert>
        ) : sub.isPending ? (
          <Spinner />
        ) : sub.isError ? (
          <Alert>Failed to load billing information.</Alert>
        ) : (
          <div className="space-y-5">
            <SubscriptionCard
              sub={sub.data}
              isAdmin={isAdmin}
              onPlanChange={(plan) => setPlan.mutate(plan)}
            />
            {setPlan.isError && <Alert tone="red">Failed to change plan.</Alert>}
            {usage.isPending ? (
              <Spinner />
            ) : usage.isError ? (
              <Alert>Failed to load usage data.</Alert>
            ) : (
              <UsageCard usage={usage.data} />
            )}
          </div>
        )}
      </AppShell>
    </RequireAuth>
  )
}
