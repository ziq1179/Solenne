import { Pool, type PoolClient } from 'pg'
import { applyBaseSchema, APP_ROLE, hardenRls, isHardeningApplied, isSchemaApplied, type SqlExecutor } from './schema.js'
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
  private constructor(private readonly pool: Pool) {}

  /** Connects to a real Postgres server and applies schema/RLS hardening if absent. */
  static async open(opts: PoolOptions): Promise<Db> {
    const ssl = opts.ssl === undefined ? true : opts.ssl
    const pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 16,
      min: 0,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
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
      if (!(await isSchemaApplied(q))) {
        await applyBaseSchema(q)
      }
      // Hardening is conditional (and idempotent): a schema may exist but not
      // yet be hardened, e.g. if an earlier migration died mid-way.
      if (!(await isHardeningApplied(q))) {
        await hardenRls(q)
      }
    } finally {
      client.release()
    }
    return db
  }

  /**
   * Runs `fn` inside a single transaction on one pooled connection, as the
   * non-superuser app role with `app.current_tenant` scoped to that
   * transaction via `SET LOCAL` (auto-reverts at COMMIT/ROLLBACK). Every
   * tenant-scoped query MUST go through here so RLS actually enforces
   * isolation across concurrent requests.
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
      return fn(toQ(client))
    })
  }

  /**
   * Runs `fn` in a transaction as the database owner/superuser (RLS bypassed).
   * Reserved for tenant-agnostic flows: tenancy resolution, login, seed.
   */
  system<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    return this.transact((client) => fn(toQ(client)))
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