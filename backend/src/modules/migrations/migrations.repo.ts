import type { Db, Q, Row } from '../../db/index.js'
import { MIGRATION_LOCK_KEY, newId } from '../../db/index.js'
import { TENANT_PURGED_TABLES, TENANT_SCOPED_TABLES, hardenRls } from '../../db/schema.js'
import {
  assertDedicatedSchemaCatalog,
  buildDedicatedSchemaDdl,
  checksumSql,
  MIGRATION_PLATFORM_AUDIT_ACTIONS,
  rolePermissionsCopySql,
  schemaNameForTenant,
  type TableChecksum,
} from '../../db/dedicated-schema.js'
import { getSubscription } from '../billing/billing.repo.js'
import { httpError } from '../../http/errors.js'
import { audit } from '../../lib/audit.js'
import { markTenantWritesPaused, markTenantWritesResumed } from './quiescence.js'

/**
 * Migration state machine — Phase 5 dedicated per-tenant tier.
 *
 * Lifecycle (public surface) and invariants:
 *   prepared  → schema materialized, data NOT yet copied (crash-safe)
 *   copying   → copy in progress; MANIFEST persisted before any copy
 *   verifying → manifest vs dedicated checksums compared (pin: count + md5)
 *   cutover   → tenants row flipped (isolation_mode='dedicated_schema'),
 *               schema is now authoritative
 *   purged    → public rows collapsed (children-first), active refresh
 *               tokens retained, dedicated schema kept as the tenant's home
 *   failed    → verification mismatch / catalog error → schema dropped,
 *               tenant stays 'shared', retry is clean
 *   aborted   → operator abort pre-cutover → schema dropped
 *   rolled_back → cutover reached, operator rolled back pre-purge
 *
 * Every step writes an audit row (the audit_logs row lives inside the affected
 * tenant's scope via the machine's db.system context-free insert).
 */

export type MigrationStatus =
  | 'prepared'
  | 'copying'
  | 'verifying'
  | 'cutover'
  | 'purged'
  | 'failed'
  | 'aborted'
  | 'rolled_back'

export interface TenantRow {
  id: string
  tenant: string
  status: string
  isolationMode: string
  dedicatedSchema: string | null
  dedicatedRegion: string | null
}

export interface TenantStatusBefore {
  tenantStatus: string
  isolationMode: string
  dedicatedSchema: string | null
  dedicatedRegion: string | null
  plan: string
  subscriptionStatus: string
}

export interface MigrationRow {
  migrationId: string
  tenantId: string
  isolationFrom: string
  isolationTo: string
  status: MigrationStatus
  schemaName: string | null
  manifestJson: Record<string, TableChecksum> | null
  verificationJson: Record<string, TableChecksum> | null
  statusBefore: TenantStatusBefore | null
  startedAt: string
  gotIntoCutoverAt: string | null
  purgedAt: string | null
  completedAt: string | null
}

interface MigrationRowRow extends Row {
  migrationId: string
  tenantId: string
  isolationFrom: string
  isolationTo: string
  status: MigrationStatus
  schemaName: string | null
  manifestJson: Record<string, TableChecksum> | null
  verificationJson: Record<string, TableChecksum> | null
  statusBefore: TenantStatusBefore | null
  startedAt: string | null
  gotIntoCutoverAt: string | null
  purgedAt: string | null
  completedAt: string | null
}

const MIGRATION_COLS = `
  migration_id AS "migrationId", tenant_id AS "tenantId",
  isolation_from AS "isolationFrom", isolation_to AS "isolationTo", status,
  schema_name AS "schemaName", manifest_json AS "manifestJson",
  verification_json AS "verificationJson", status_before AS "statusBefore",
  started_at::text AS "startedAt", got_into_cutover_at::text AS "gotIntoCutoverAt",
  purged_at::text AS "purgedAt", completed_at::text AS "completedAt"`

const INFLIGHT_FILTER = `status NOT IN ('purged', 'failed', 'aborted', 'rolled_back')`

function mapMigration(row: MigrationRowRow): MigrationRow {
  return {
    migrationId: row.migrationId,
    tenantId: row.tenantId,
    isolationFrom: row.isolationFrom,
    isolationTo: row.isolationTo,
    status: row.status,
    schemaName: row.schemaName,
    manifestJson: row.manifestJson,
    verificationJson: row.verificationJson,
    statusBefore: row.statusBefore,
    startedAt: row.startedAt ?? '',
    gotIntoCutoverAt: row.gotIntoCutoverAt,
    purgedAt: row.purgedAt,
    completedAt: row.completedAt,
  }
}

async function getMigrationRow(q: Q, migrationId: string): Promise<MigrationRow> {
  const res = await q.query<MigrationRowRow>(
    `SELECT ${MIGRATION_COLS} FROM tenant_migrations WHERE migration_id = $1`,
    [migrationId],
  )
  const row = res.rows[0]
  if (!row) throw httpError.notFound('Migration not found')
  return mapMigration(row)
}

async function getTenantRow(q: Q, tenantId: string): Promise<TenantRow> {
  const res = await q.query<Row>(
    `SELECT id, name, status,
            isolation_mode AS "isolationMode",
            dedicated_schema AS "dedicatedSchema",
            dedicated_region AS "dedicatedRegion"
     FROM tenants WHERE id = $1`,
    [tenantId],
  )
  const row = res.rows[0]
  if (!row) throw httpError.notFound('Tenant not found')
  return row as unknown as TenantRow
}

/** Pre-flight gate: tenant shared + active, subscription enterprise + active. */
async function assertStartEligible(q: Q, tenantId: string): Promise<TenantStatusBefore> {
  const t = await getTenantRow(q, tenantId)
  if (t.isolationMode !== 'shared') {
    throw httpError.conflict('Tenant is already on a dedicated tier')
  }
  if (t.status !== 'active') {
    throw httpError.conflict('Tenant is not active')
  }
  const sub = await getSubscription(q, tenantId)
  if (sub.plan !== 'enterprise' || sub.status !== 'active') {
    throw httpError.unprocessable('Dedicated tier requires an active enterprise subscription')
  }
  return {
    tenantStatus: t.status,
    isolationMode: t.isolationMode,
    dedicatedSchema: t.dedicatedSchema,
    dedicatedRegion: t.dedicatedRegion,
    plan: sub.plan,
    subscriptionStatus: sub.status,
  }
}

async function captureManifest(q: Q, tenantId: string): Promise<Record<string, TableChecksum>> {
  const manifest: Record<string, TableChecksum> = {}
  for (const table of TENANT_SCOPED_TABLES) {
    const { sql, params } = checksumSql(table, 'public', tenantId)
    manifest[table] = (await q.query<TableChecksum>(sql, params)).rows[0]!
  }
  const rp = checksumSql('role_permissions', 'public', tenantId, true)
  manifest.role_permissions = (await q.query<TableChecksum>(rp.sql, rp.params)).rows[0]!
  return manifest
}

async function captureVerification(
  q: Q,
  schemaName: string,
): Promise<Record<string, TableChecksum>> {
  const verify: Record<string, TableChecksum> = {}
  for (const table of TENANT_SCOPED_TABLES) {
    const { sql } = checksumSql(table, schemaName)
    verify[table] = (await q.query<TableChecksum>(sql)).rows[0]!
  }
  const rp = checksumSql('role_permissions', schemaName)
  verify.role_permissions = (await q.query<TableChecksum>(rp.sql)).rows[0]!
  return verify
}

function diffManifest(
  manifest: Record<string, TableChecksum>,
  verify: Record<string, TableChecksum>,
): Record<string, { public: TableChecksum; dedicated: TableChecksum }> {
  const diff: Record<string, { public: TableChecksum; dedicated: TableChecksum }> = {}
  for (const table of Object.keys(manifest)) {
    const a = manifest[table]!
    const b = verify[table]
    if (!b || a.count !== b.count || a.checksum !== b.checksum) {
      diff[table] = { public: a, dedicated: b ?? { count: -1, checksum: 'missing' } }
    }
  }
  return diff
}

export async function getMigration(db: Db, migrationId: string): Promise<MigrationRow | null> {
  return db.system(async (q) => {
    const res = await q.query<MigrationRowRow>(
      `SELECT ${MIGRATION_COLS} FROM tenant_migrations WHERE migration_id = $1`,
      [migrationId],
    )
    return res.rows[0] ? mapMigration(res.rows[0]) : null
  })
}

export async function getActiveMigration(db: Db, tenantId: string): Promise<MigrationRow | null> {
  return db.system(async (q) => {
    const res = await q.query<MigrationRowRow>(
      `SELECT ${MIGRATION_COLS} FROM tenant_migrations
       WHERE tenant_id = $1 AND ${INFLIGHT_FILTER}
       ORDER BY started_at DESC LIMIT 1`,
      [tenantId],
    )
    return res.rows[0] ? mapMigration(res.rows[0]) : null
  })
}

export async function tenantIsolation(db: Db, tenantId: string): Promise<TenantRow> {
  return db.system((q) => getTenantRow(q, tenantId))
}

/**
 * Step 1 — create the dedicated schema: DDL materialization + hardening +
 * catalog assertion. Runs on ONE session (withBootstrap) so GRANTs/ownership
 * transfers share visibility. Crash-safe: every statement is idempotent
 * (`IF NOT EXISTS`), and re-materialization converges on the next attempt.
 */
async function materializeDedicatedSchema(
  db: Db,
  schemaName: string,
  tenantId: string,
): Promise<void> {
  await db.withBootstrap(async (q) => {
    await q.exec(`CREATE SCHEMA IF NOT EXISTS "${schemaName}" AUTHORIZATION app_rls_user`)
    const ddl = await buildDedicatedSchemaDdl()
    await q.exec(`BEGIN`)
    await q.exec(`SELECT set_config('search_path', $1, true)`, [`${schemaName}, public`])
    await q.exec(ddl)
    await q.exec(`COMMIT`)
    // Hardening transfers tables to app_rls_user, creates policies/force + RLS.
    // role_permissions is NOT in TENANT_SCOPED_TABLES, so re-own explicitly.
    await hardenRls(q, schemaName)
    await q.exec(`ALTER TABLE "${schemaName}".role_permissions OWNER TO app_rls_user`)
    await assertDedicatedSchemaCatalog(q, schemaName)
  })
  await db.system(async (q) => {
    await audit(q, {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: 'schema_created',
      entityType: 'tenant',
      entityId: tenantId,
      after: { schemaName, tables: TENANT_SCOPED_TABLES.length, rolePermissionsCopy: true },
    })
  })
}

/** Step 2 — copy every tenant table + the join-filtered role_permissions. */
async function copyTenantData(
  db: Db,
  migrationId: string,
  tenantId: string,
  schemaName: string,
): Promise<void> {
  await db.system(async (q) => {
    await q.exec(`SET CONSTRAINTS ALL DEFERRED`)
    for (const table of TENANT_SCOPED_TABLES) {
      if (table === 'audit_logs') {
        const actions = MIGRATION_PLATFORM_AUDIT_ACTIONS.map((a) => `'${a}'`).join(', ')
        await q.exec(
          `INSERT INTO "${schemaName}".audit_logs SELECT * FROM public.audit_logs
           WHERE tenant_id = $1 AND action NOT IN (${actions})`,
          [tenantId],
        )
        continue
      }
      await q.exec(
        `INSERT INTO "${schemaName}".${table} SELECT * FROM public.${table} WHERE tenant_id = $1`,
        [tenantId],
      )
    }
    const copy = rolePermissionsCopySql(schemaName, tenantId)
    await q.exec(copy.sql, copy.params)
  })
  await db.system(async (q) => {
    await q.exec(`UPDATE tenant_migrations SET status = 'copying' WHERE migration_id = $1`, [
      migrationId,
    ])
    await audit(q, {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: 'copy_completed',
      entityType: 'tenant_migration',
      entityId: migrationId,
      after: { schemaName, tablesCopied: TENANT_SCOPED_TABLES.length + 1 },
    })
  })
}

/** Step 3 — verify: manifest vs dedicated checksums inside ONE transaction. */
async function verifyTenantData(
  db: Db,
  migrationId: string,
  tenantId: string,
  schemaName: string,
): Promise<void> {
  await db.system(async (q) => {
    const row = await getMigrationRow(q, migrationId)
    if (row.status !== 'copying') {
      throw httpError.conflict(`Cannot verify a migration in status '${row.status}'`)
    }
    const verification = await captureVerification(q, schemaName)
    const diff = diffManifest(row.manifestJson ?? {}, verification)
    if (Object.keys(diff).length > 0) {
      const detail = Object.entries(diff)
        .map(
          ([t, d]) =>
            `${t} public=${d.public.count}/${d.public.checksum} dedicated=${d.dedicated.count}/${d.dedicated.checksum}`,
        )
        .join('; ')
      throw new Error(`verify_mismatch tables=[${Object.keys(diff).join(', ')}] ${detail}`)
    }
    await q.exec(
      `UPDATE tenant_migrations SET status = 'verifying', verification_json = $1 WHERE migration_id = $2`,
      [JSON.stringify(verification), migrationId],
    )
    await audit(q, {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: 'verified',
      entityType: 'tenant_migration',
      entityId: migrationId,
      after: { schemaName, tablesVerified: TENANT_SCOPED_TABLES.length + 1 },
    })
  })
}

/**
 * Public entrypoint 1a — `prepare`: preflight + quiesce + manifest + schema.
 * Order inside the atomic system transaction:
 *   advisory lock → in-flight guard → eligibility (status must be 'active') →
 *   persist status_before → manifest snapshot → insert migration row →
 *   flip `tenants.status = 'migrating'`.
 * The flip happens IN THE SAME TRANSACTION as the manifest pin, so there is
 * no moment where writes could land between "writes paused" (status) and
 * "manifest frozen". Returns the row in `prepared`; the caller then copies.
 */
export async function prepareMigration(db: Db, tenantId: string): Promise<MigrationRow> {
  const migrationId = newId()
  const schemaName = schemaNameForTenant(tenantId)

  markTenantWritesPaused(tenantId)

  const row = await db.system(async (q) => {
    await q.exec(`SELECT pg_advisory_xact_lock($1)`, [MIGRATION_LOCK_KEY])
    const active = await q.query<{ migrationId: string }>(
      `SELECT migration_id AS "migrationId" FROM tenant_migrations
       WHERE tenant_id = $1 AND ${INFLIGHT_FILTER} LIMIT 1`,
      [tenantId],
    )
    if (active.rows[0]) {
      throw httpError.conflict('Tenant already has an in-flight migration')
    }
    const statusBefore = await assertStartEligible(q, tenantId)
    const manifest = await captureManifest(q, tenantId)
    await q.exec(
      `INSERT INTO tenant_migrations
         (migration_id, tenant_id, status, schema_name, manifest_json, status_before)
       VALUES ($1, $2, 'prepared', $3, $4::jsonb, $5::jsonb)`,
      [migrationId, tenantId, schemaName, JSON.stringify(manifest), JSON.stringify(statusBefore)],
    )
    await q.exec(`UPDATE tenants SET status = 'migrating' WHERE id = $1`, [tenantId])
    return getMigrationRow(q, migrationId)
  })

  // Manifest + quiescence are now durable; the schema materialization is
  // idempotent (`IF NOT EXISTS`), so a crash mid-pass converges on retry.
  await materializeDedicatedSchema(db, schemaName, tenantId)
  return row
}

/**
 * Public entrypoint 1b — `copy`: the data pass against the already-pinned
 * manifest. NOT recommended to run with the public side still writable — the
 * write-quiescence gate (status 'migrating') is what guarantees the copied
 * set still equals the manifest. This is also the seam the adversarial
 * mismatch test uses (inject a public row between prepare and copy).
 */
export async function copyMigration(db: Db, migrationId: string): Promise<MigrationRow> {
  const row = await getMigration(db, migrationId)
  if (!row) throw httpError.notFound('Migration not found')
  if (row.status !== 'prepared') {
    throw httpError.conflict(`Cannot copy a migration in status '${row.status}'`)
  }
  await copyTenantData(db, row.migrationId, row.tenantId, row.schemaName!)
  return (await getMigration(db, row.migrationId))!
}

/** Convenience — the route composes prepare + copy. */
export async function startMigration(db: Db, tenantId: string): Promise<MigrationRow> {
  const row = await prepareMigration(db, tenantId)
  return copyMigration(db, row.migrationId)
}

/**
 * Public entrypoint 2 — `verify`: advances `copying` → `verifying` when the
 * pinned checksum comparison passes. On mismatch the row is left `copying`,
 * nothing is mutated, and the exact diff detail is in the Error message —
 * the seam the adversarial mismatch test exercises. The caller decides
 * between `failMigration` (drop + mark failed) and `abort`.
 */
export async function verifyMigration(db: Db, migrationId: string): Promise<MigrationRow> {
  const row = await getMigration(db, migrationId)
  if (!row) throw httpError.notFound('Migration not found')
  await verifyTenantData(db, row.migrationId, row.tenantId, row.schemaName!)
  return (await getMigration(db, row.migrationId))!
}

/**
 * Marks a verification failure: drops the schema, records `failed`,
 * and leaves the tenant fully shared so a retry is clean. Used by the routes
 * when verifyMigration throws a mismatch/catalog error (adversarial test 1).
 */
export async function failMigration(db: Db, migrationId: string, reason: string): Promise<MigrationRow> {
  const row = await getMigration(db, migrationId)
  if (!row) throw httpError.notFound('Migration not found')
  await db.system(async (q) => {
    await q.exec(`UPDATE tenant_migrations SET status = 'failed', completed_at = now() WHERE migration_id = $1`, [
      migrationId,
    ])
    const restoredStatus = row.statusBefore?.tenantStatus ?? 'active'
    await q.exec(`UPDATE tenants SET status = $2, isolation_mode = 'shared', dedicated_schema = NULL WHERE id = $1`, [
      row.tenantId,
      restoredStatus,
    ])
  })
  if (row.schemaName) {
    await db.withBootstrap(async (q) => {
      await q.exec(`DROP SCHEMA IF EXISTS "${row.schemaName}" CASCADE`)
    })
  }
  await db.system(async (q) => {
    await audit(q, {
      tenantId: row.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'verify_failed',
      entityType: 'tenant_migration',
      entityId: migrationId,
      before: row.statusBefore ?? undefined,
      after: { reason, schemaDropped: true },
    })
  })
  markTenantWritesResumed(row.tenantId)
  return (await getMigration(db, migrationId))!
}

/**
 * Public entrypoint 3 — `cutover`: final eligibility re-check + tenants-row
 * flip (isolation_mode → dedicated_schema, dedicated_schema set, status back
 * to 'active'). After this instant the tenant's own schema is authoritative
 * and every subsequent login mints schema-routing JWTs. Writes un-pause the
 * instant the flip commits.
 */
export async function cutoverMigration(db: Db, migrationId: string): Promise<MigrationRow> {
  return db.system(async (q) => {
    await q.exec(`SELECT pg_advisory_xact_lock($1)`, [MIGRATION_LOCK_KEY])
    const row = await getMigrationRow(q, migrationId)
    if (row.status !== 'verifying') {
      throw httpError.conflict(`Cannot cut over a migration in status '${row.status}'`)
    }
    const sub = await getSubscription(q, row.tenantId)
    if (sub.plan !== 'enterprise' || sub.status !== 'active') {
      throw httpError.conflict('Enterprise subscription no longer active — cutover aborted')
    }
    const restoredStatus = row.statusBefore?.tenantStatus ?? 'active'
    await q.exec(
      `UPDATE tenants
       SET isolation_mode = 'dedicated_schema', dedicated_schema = $2, status = $3
       WHERE id = $1`,
      [row.tenantId, row.schemaName, restoredStatus],
    )
    await q.exec(`UPDATE tenant_migrations SET status = 'cutover', got_into_cutover_at = now() WHERE migration_id = $1`, [
      migrationId,
    ])
    await audit(q, {
      tenantId: row.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'cutover',
      entityType: 'tenant_migration',
      entityId: migrationId,
      before: row.statusBefore ?? undefined,
      after: { schemaName: row.schemaName },
    })
    markTenantWritesResumed(row.tenantId)
    return getMigrationRow(q, migrationId)
  })
}

interface RoleMappingsRow {
  roleId: string
  mappings: string
  n: number
}

/** Per-role mapping profile (`role_id` → comma-joined permission ids, sorted). */
async function profileRoleMappings(
  q: Q,
  from: { kind: 'public'; tenantId: string } | { kind: 'schema'; schemaName: string },
): Promise<RoleMappingsRow[]> {
  const fromSql =
    from.kind === 'public'
      ? `public.role_permissions rp
         WHERE rp.role_id IN (SELECT r.id FROM public.roles r WHERE r.tenant_id = $1)
         GROUP BY rp.role_id`
      : `"${from.schemaName}".role_permissions rp
         GROUP BY rp.role_id`
  const res = await q.query<RoleMappingsRow>(
    `SELECT rp.role_id::text AS "roleId",
            string_agg(rp.permission_id::text, ',' ORDER BY rp.permission_id::text) AS "mappings",
            count(*)::int AS "n"
     FROM ${fromSql}
     ORDER BY rp.role_id::text`,
    from.kind === 'public' ? [from.tenantId] : [],
  )
  return res.rows
}

/**
 * Public entrypoint 4 — `purge`: after cutover, collapse the shared `public`
 * tenant rows (children-first), keep the STILL-ACTIVE refresh tokens (they
 * power in-flight sessions past the flip) and the dedicated schema (the
 * tenant's new home — post-purge reads resolve from it). The parity gate only
 * checks the per-role permission mappings, which the purge must not disturb.
 */
export async function purgeMigration(db: Db, migrationId: string): Promise<MigrationRow> {
  return db.system(async (q) => {
    const row = await getMigrationRow(q, migrationId)
    if (row.status !== 'cutover') {
      throw httpError.conflict(`Cannot purge a migration in status '${row.status}'`)
    }
    const schemaName = row.schemaName!

    // 1. Parity gate: dedicated role_permissions must still equal the shared
    //    (source-of-truth) mapping for this tenant's roles — refuse to
    //    collapse anything otherwise.
    const dedicated = await profileRoleMappings(q, { kind: 'schema', schemaName })
    const shared = await profileRoleMappings(q, { kind: 'public', tenantId: row.tenantId })
    if (
      dedicated.length !== shared.length ||
      dedicated.some(
        (d, i) => d.roleId !== shared[i]?.roleId || d.mappings !== shared[i]?.mappings || d.n !== shared[i]?.n,
      )
    ) {
      throw httpError.conflict('Dedicated role_permissions differ from the shared snapshot — purge refused')
    }

    // 2. Token retention: the session registry survives — active tokens live
    //    until TTL (§3.3 Step 5); only expired/revoked collapse.
    const kept = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.refresh_tokens
       WHERE tenant_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [row.tenantId],
    )
    await q.exec(
      `DELETE FROM public.refresh_tokens
       WHERE tenant_id = $1 AND (revoked_at IS NOT NULL OR expires_at <= now())`,
      [row.tenantId],
    )

    // 3. Collapse public rows children-first (refresh_tokens excluded — the
    //    retained registry above, cross-tenant by design).
    for (let i = TENANT_PURGED_TABLES.length - 1; i >= 0; i--) {
      const table = TENANT_PURGED_TABLES[i]!
      await q.exec(`DELETE FROM public.${table} WHERE tenant_id = $1`, [row.tenantId])
    }

    await q.exec(
      `UPDATE tenant_migrations
       SET status = 'purged', purged_at = now(), completed_at = now()
       WHERE migration_id = $1`,
      [migrationId],
    )
    await audit(q, {
      tenantId: row.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'purged',
      entityType: 'tenant_migration',
      entityId: migrationId,
      after: {
        schemaName,
        tablesPurged: TENANT_PURGED_TABLES.length,
        rolePermissionsPreserved: true,
        retainedRefreshTokens: kept.rows[0]?.n ?? 0,
      },
    })
    return getMigrationRow(q, migrationId)
  })
}

/**
 * Public entrypoint 5 — `abort`: PRE-cutover operator abort. Drops the schema,
 * marks the row `aborted`; the tenant remains shared.
 */
export async function abortMigration(db: Db, migrationId: string): Promise<MigrationRow> {
  const row = await db.system(async (q) => {
    const existing = await getMigrationRow(q, migrationId)
    if (existing.status === 'cutover' || existing.status === 'purged') {
      throw httpError.conflict(`Cannot abort a migration in status '${existing.status}'`)
    }
    await q.exec(`UPDATE tenant_migrations SET status = 'aborted', completed_at = now() WHERE migration_id = $1`, [
      migrationId,
    ])
    const restoredStatus = existing.statusBefore?.tenantStatus ?? 'active'
    await q.exec(
      `UPDATE tenants SET status = $2, isolation_mode = 'shared', dedicated_schema = NULL WHERE id = $1`,
      [existing.tenantId, restoredStatus],
    )
    return existing
  })
  if (row.schemaName) {
    await db.withBootstrap(async (q) => {
      await q.exec(`DROP SCHEMA IF EXISTS "${row.schemaName}" CASCADE`)
    })
  }
  await db.system(async (q) => {
    await audit(q, {
      tenantId: row.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'aborted',
      entityType: 'tenant_migration',
      entityId: migrationId,
      before: row.statusBefore ?? undefined,
    })
  })
  markTenantWritesResumed(row.tenantId)
  return (await getMigration(db, migrationId))!
}

/**
 * Public entrypoint 6 — `rollback`: cutover reached, operator rolls back to
 * shared BEFORE purge. Restores the tenants row, drops the schema and marks
 * the row `rolled_back`.
 */
export async function rollbackMigration(db: Db, migrationId: string): Promise<MigrationRow> {
  const row = await db.system(async (q) => {
    const existing = await getMigrationRow(q, migrationId)
    if (existing.status !== 'cutover') {
      throw httpError.conflict(`Cannot roll back a migration in status '${existing.status}'`)
    }
    const sb = existing.statusBefore
    await q.exec(
      `UPDATE tenants SET isolation_mode = $2, dedicated_schema = NULL, status = $3 WHERE id = $1`,
      [existing.tenantId, sb?.isolationMode ?? 'shared', sb?.tenantStatus ?? 'active'],
    )
    await q.exec(`UPDATE tenant_migrations SET status = 'rolled_back', completed_at = now() WHERE migration_id = $1`, [
      migrationId,
    ])
    await audit(q, {
      tenantId: existing.tenantId,
      actorType: 'system',
      actorId: null,
      action: 'rolled_back',
      entityType: 'tenant_migration',
      entityId: migrationId,
      before: existing.statusBefore ?? undefined,
    })
    markTenantWritesResumed(existing.tenantId)
    return existing
  })
  if (row.schemaName) {
    await db.withBootstrap(async (q) => {
      await q.exec(`DROP SCHEMA IF EXISTS "${row.schemaName}" CASCADE`)
    })
  }
  return (await getMigration(db, migrationId))!
}