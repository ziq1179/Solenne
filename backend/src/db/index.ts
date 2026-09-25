import { Pool, type PoolClient } from 'pg'
import { applyAtsSchema, applyBaseSchema, applyBillingSchema, applyNotificationsSchema, applyOnboardingSchema, applyAiSchema, applyPayrollSchema, applyPerformanceSchema, applyBenefitsSchema, applyIntegrationsSchema, applySsoSchema, applyDedicatedTierSchema, applyDedicatedTierAuthSchema, assertSchemaName, ensureMigrationTable, isHardeningApplied, isPhase2Applied, isSchemaApplied, markPhase2Applied, APP_ROLE, hardenRls, type SqlExecutor } from './schema.js'
import { ulidSafeUuid, sha256Hex } from '../lib/crypto.js'

export interface PoolOptions {
  connectionString: string
  /** Max simultaneous connections to Postgres (min is 0). */
  max?: number
  /** TLS: `true` (verify against system CAs) or a pg `ssl` config. Never disable silently. */
  ssl?: Pool['options']['ssl']
}

/**
 * Minimal queryable surface shared by system and tenant transactions. Every
 * repository works against this interface, so the underlying driver is an
 * implementation detail.
 */
export interface Q {
  query<R = Row>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
  exec(sql: string, params?: unknown[]): Promise<void>
}

export interface Row {
  [column: string]: unknown
}

/** Advisory-lock key for the schema bootstrap (arbitrary but stable int8). */
export const MIGRATION_LOCK_KEY = 81972301

function toQ(client: PoolClient): Q {
  return {
    async query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> {
      const res = params?.length ? await client.query(sql, params as any[]) : await client.query(sql)
      return { rows: res.rows as R[] }
    },
    async exec(sql: string, params?: unknown[]): Promise<void> {
      if (params?.length) await client.query(sql, params as any[])
      else await client.query(sql)
    },
  }
}

export class Db {
  /** tenantId → dedicated schema name, populated at auth time from the JWT. */
  private readonly tenantSchemas = new Map<string, string>()

  private constructor(private readonly pool: Pool) {}

  /** Connects to a real Postgres server and applies schema/RLS hardening if absent. */
  static async open(opts: PoolOptions): Promise<Db> {
    const ssl = opts.ssl === undefined ? true : opts.ssl
    const pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 16,
      min: 0,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 60_000,
      ssl,
    })

    // Fail fast at boot with a real error rather than per-request timeouts.
    const probe = await pool.connect()
    try {
      await probe.query('SELECT 1')
    } finally {
      probe.release()
    }

    const db = new Db(pool)
    // Bootstrap uses ONE checked-out connection: grants, ownership transfers
    // and SET LOCAL ROLE must all be visible to each subsequent statement,
    // which is impossible at pool level.
    const client = await pool.connect()
    try {
      const q = toQ(client)
      // The bootstrap is check-then-act (is*Applied guards), so a fresh deploy
      // can race N serverless instances: each sees "not applied" and starts
      // the DDL + hardening pass at once. Serialize with a session-level
      // advisory lock on THIS connection — the first instance runs the
      // idempotent migrations and records the schema_migrations markers;
      // everyone else blocks, sees the markers, and becomes a no-op. The lock
      // is released explicitly below, and a crash mid-pass is safe because
      // TCP teardown frees session-level advisory locks.
      await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY])
      try {
        if (!(await isSchemaApplied(q))) {
          await applyBaseSchema(q)
        }
        // Hardening is conditional (and idempotent): a schema may exist but not
        // yet be hardened, e.g. if an earlier migration died mid-way.
        if (!(await isHardeningApplied(q))) {
          await hardenRls(q)
        }
        // Phase 2 migrations run once per version (recorded in schema_migrations)
        // instead of every boot: each phase re-does its DDL + a full hardening
        // pass, and those hundreds of round trips over the Neon pooler pushed the
        // e2e boot hook past its timeout. First boot on an untouched database
        // still converges every environment, then the marker persists.
        await ensureMigrationTable(q)
        for (const [name, apply] of [
          ['phase2-ats', applyAtsSchema],
          ['phase2-onboarding', applyOnboardingSchema],
          ['phase2-notifications', applyNotificationsSchema],
          ['phase2-billing', applyBillingSchema],
          ['phase3-ai', applyAiSchema],
          ['phase4-payroll', applyPayrollSchema],
          ['phase4-performance', applyPerformanceSchema],
          ['phase4-benefits', applyBenefitsSchema],
          ['phase4-integrations', applyIntegrationsSchema],
          ['phase5-sso', applySsoSchema],
          ['phase5-dedicated-tier', applyDedicatedTierSchema],
          ['phase5-dedicated-tier-auth', applyDedicatedTierAuthSchema],
        ] as [string, (exec: SqlExecutor) => Promise<void>][]) {
          if (!(await isPhase2Applied(q, name))) {
            await apply(q)
          }
          await markPhase2Applied(q, name)
        }
      } finally {
        await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY])
      }
    } finally {
      client.release()
    }
    return db
  }

  /**
   * Records the tenant's routing schema (from the verified JWT, per the
   * "SET LOCAL comes from the JWT" discipline). `null`/empty clears it back to
   * the shared `public` routing. Zero-cost in-memory lookup: no per-request DB
   * round trip on the hot path.
   */
  setTenantSchema(tenantId: string, schema: string | null | undefined): void {
    if (schema) {
      assertSchemaName(schema)
      this.tenantSchemas.set(tenantId, schema)
    } else {
      this.tenantSchemas.delete(tenantId)
    }
  }

  /**
   * Runs `fn` inside a single transaction on one pooled connection, as the
   * non-superuser app role with `app.current_tenant` scoped to that
   * transaction via `SET LOCAL` (auto-reverts at COMMIT/ROLLBACK). Every
   * tenant-scoped query MUST go through here so RLS actually enforces
   * isolation across concurrent requests.
   *
   * For a dedicated tenant the session `search_path` is prefixed with its own
   * schema (registered by `setTenantSchema` at auth time) so every unqualified
   * reference resolves to the tenant's physical copy; `public` stays second
   * for the global tables (`tenants`, `permissions`).
   */
  tenant<T>(tenantId: string, fn: (q: Q) => Promise<T>): Promise<T> {
    if (!tenantId || typeof tenantId !== 'string') {
      // Tenant context for SET LOCAL must always come from the verified JWT.
      // Bail loudly rather than silently matching zero rows.
      return Promise.reject(new Error('tenantId is required'))
    }
    return this.transact(async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`)
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId])
      const schema = this.tenantSchemas.get(tenantId)
      if (schema) {
        await client.query(`SELECT set_config('search_path', $1, true)`, [`${schema}, public`])
      }
      return fn(toQ(client))
    })
  }

  /**
   * Runs `fn` in a transaction as the database owner/superuser (RLS bypassed).
   * Reserved for tenant-agnostic flows: tenancy resolution, login, seed.
   *
   * Optional `{ schema }` (assertSchemaName-guarded) re-scopes the transaction's
   * `search_path` to a tenant schema — the auth flow uses it to resolve a
   * dedicated tenant's user/roles/permissions from the tenant's own copy
   * (login/refresh post-purge), while the tenant row itself is always a
   * `public.tenants` read.
   */
  system<T>(fn: (q: Q) => Promise<T>, opts?: { schema?: string }): Promise<T> {
    return this.transact(async (client) => {
      if (opts?.schema) {
        assertSchemaName(opts.schema)
        await client.query(`SELECT set_config('search_path', $1, true)`, [`${opts.schema}, public`])
      }
      return fn(toQ(client))
    })
  }

  /**
   * Checks out one pooled connection for the whole of `fn` (DDL + hardening
   * that must share a session: GRANTs, ownership transfers, SET LOCAL ROLE).
   * Same discipline `Db.open`'s bootstrap uses. The connection is always
   * released; a crash mid-pass is safe because the tier machine is
   * check-then-act and idempotent on retry.
   */
  async withBootstrap<T>(fn: (q: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      return await fn(toQ(client))
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // connection may already be broken; nothing else to do
      }
      throw err
    } finally {
      client.release()
    }
  }

  /** Raw pooled access — used only by bootstrap/migration/seed scripts. */
  unsafe(): SqlExecutor {
    const pool = this.pool
    return {
      async query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> {
        const res = params?.length ? await pool.query(sql, params as any[]) : await pool.query(sql)
        return { rows: res.rows as R[] }
      },
      async exec(sql: string, params?: unknown[]): Promise<void> {
        if (params?.length) await pool.query(sql, params as any[])
        else await pool.query(sql)
      },
    }
  }

  close(): Promise<void> {
    return this.pool.end()
  }

  private transact<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN')
        const out = await fn(client)
        await client.query('COMMIT')
        return out
      } catch (err) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // connection may already be broken; nothing else to do
        }
        throw err
      } finally {
        client.release()
      }
    })
  }
}

/** Generates a time-ordered UUIDv7-shaped id (unique + sortable). */
export function newId(): string {
  return ulidSafeUuid()
}

/** Random opaque token (for refresh tokens). */
export function newToken(): string {
  return sha256Hex(`${crypto.randomUUID()}${Date.now()}${Math.random()}`)
}