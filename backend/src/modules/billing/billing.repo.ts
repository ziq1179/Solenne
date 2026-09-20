import type { Q, Row } from '../../db/index.js'
import { newId } from '../../db/index.js'

/** Plan → default seat allowance. Matches the tenants.plan enum. */
export const PLAN_SEAT_LIMITS: Record<string, number> = {
  trial: 5,
  core: 25,
  grow: 100,
  enterprise: 1000,
}

export const PLAN_NAMES = Object.keys(PLAN_SEAT_LIMITS)

export interface Subscription {
  id: string
  tenantId: string
  plan: string
  status: string
  trialEndsAt: string | null
  currentPeriodStart: string
  currentPeriodEnd: string
  seatLimit: number
  seatsUsed: number
}

interface SubscriptionRow extends Row {
  id: string
  tenantId: string
  plan: string
  status: string
  trialEndsAt: string | null
  currentPeriodStart: string
  currentPeriodEnd: string
  seatLimit: number
}

export interface UsageRow {
  metric: string
  total: number
  lastAt: string | null
}

const SUB_COLS = `
  s.id, s.tenant_id AS "tenantId", s.plan, s.status,
  s.trial_ends_at::text AS "trialEndsAt",
  s.current_period_start::text AS "currentPeriodStart",
  s.current_period_end::text AS "currentPeriodEnd",
  s.seat_limit AS "seatLimit"`

function mapSub(row: SubscriptionRow, seatsUsed: number): Subscription {
  return { ...row, seatsUsed }
}

/**
 * Returns the tenant's subscription alongside the live active-seat count.
 * Creates the default `trial` row on first sight (superset envs provisioning
 * tenants before Phase 2 billing existed), so the endpoint is never 404.
 */
export async function getSubscription(q: Q, tenantId: string): Promise<Subscription> {
  const res = await q.query<SubscriptionRow>(`SELECT ${SUB_COLS} FROM subscriptions s WHERE s.tenant_id = $1`, [
    tenantId,
  ])
  if (res.rows.length === 0) {
    await q.exec(
      `INSERT INTO subscriptions (id, tenant_id, plan, status)
       VALUES ($1, $2, 'trial', 'active')`,
      [newId(), tenantId],
    )
  }
  const seatsRes = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM employees WHERE tenant_id = $1 AND employment_status = 'active'`,
    [tenantId],
  )
  const row = (res.rows[0] ?? (await reread(q, tenantId)))!
  return mapSub(row, seatsRes.rows[0]?.n ?? 0)
}

async function reread(q: Q, tenantId: string): Promise<SubscriptionRow | null> {
  const res = await q.query<SubscriptionRow>(`SELECT ${SUB_COLS} FROM subscriptions s WHERE s.tenant_id = $1`, [
    tenantId,
  ])
  return res.rows[0] ?? null
}

/** Switches the tenant plan, rolling a fresh billing period start/end. */
export async function setPlan(q: Q, tenantId: string, plan: string): Promise<Subscription> {
  await q.exec(
    `INSERT INTO subscriptions (id, tenant_id, plan, status, seat_limit)
     VALUES ($1, $2, $3, 'active', $4)
     ON CONFLICT (tenant_id) DO UPDATE
       SET plan = EXCLUDED.plan,
           status = 'active',
           seat_limit = EXCLUDED.seat_limit,
           current_period_start = now(),
           current_period_end = now() + interval '1 month',
           trial_ends_at = NULL,
           updated_at = now()`,
    [newId(), tenantId, plan, PLAN_SEAT_LIMITS[plan] ?? PLAN_SEAT_LIMITS.trial],
  )
  return getSubscription(q, tenantId)
}

/** Appends a metered usage event inside the producer's transaction. */
export async function recordUsage(
  q: Q,
  input: { tenantId: string; metric: string; quantity?: number; entityType?: string; entityId?: string },
): Promise<void> {
  await q.exec(
    `INSERT INTO usage_events (id, tenant_id, metric, quantity, entity_type, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      newId(),
      input.tenantId,
      input.metric,
      input.quantity ?? 1,
      input.entityType ?? null,
      input.entityId ?? null,
    ],
  )
}

/** Aggregated usage per metric for a time window (inclusive). */
export async function usageSummary(
  q: Q,
  tenantId: string,
  from: string,
  to: string,
  metric?: string,
): Promise<UsageRow[]> {
  const conds = [`ue.tenant_id = $1`, `ue.occurred_at >= $2::timestamptz`, `ue.occurred_at <= $3::timestamptz`]
  const params: unknown[] = [tenantId, `${from}T00:00:00Z`, `${to}T23:59:59Z`]
  if (metric) {
    params.push(metric)
    conds.push(`ue.metric = $${params.length}`)
  }
  const res = await q.query<Row>(
    `SELECT ue.metric, sum(ue.quantity)::int AS total, max(ue.occurred_at)::text AS "lastAt"
     FROM usage_events ue
     WHERE ${conds.join(' AND ')}
     GROUP BY ue.metric
     ORDER BY ue.metric`,
    params,
  )
  return res.rows as unknown as UsageRow[]
}