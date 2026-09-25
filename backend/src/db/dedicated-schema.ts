import { readFile } from 'node:fs/promises'
import type { SqlExecutor } from './schema.js'
import {
  assertSchemaName,
  SCHEMA_RE,
  TENANT_SCOPED_TABLES,
  EXTRA_DDL,
  transformSchema,
} from './schema.js'
import { sha256Hex } from '../lib/crypto.js'

export { assertSchemaName, SCHEMA_RE }

/**
 * Global (non-tenant-scoped) tables that a tenant schema's FK targets must
 * point at through `public`: `tenants` and `permissions` never live inside a
 * tenant schema, so the canonical `REFERENCES tenants(id)` /
 * `REFERENCES permissions(id)` are qualified to `public` during
 * materialization. Everything else stays unqualified and resolves inside the
 * tenant schema via its `search_path`.
 */
export const GLOBAL_FK_TARGETS = ['tenants', 'permissions'] as const

/**
 * Within-table self-referential FK columns that are made
 * `DEFERRABLE INITIALLY IMMEDIATE` in the dedicated schema so a copy batch may
 * load reports before their managers / children before their parents and
 * resolve the edge at COMMIT. These are the ONLY deferrable constraints the
 * dedicated schema may carry (asserted in the catalog check).
 */
export const SELF_REFERENTIAL_FKS: Readonly<Record<string, readonly string[]>> = {
  employees: ['manager_employee_id'],
  departments: ['parent_id'],
}

/**
 * The canonical phase sources, in dependency order (parents before children).
 * phase5-sso.sql is intentionally absent: it only ALTERs `public.tenants`.
 */
const PHASE_SOURCES: readonly string[] = [
  '../../../phase0-1-schema.sql',
  '../../../phase2-ats.sql',
  '../../../phase2-onboarding.sql',
  '../../../phase2-notifications.sql',
  '../../../phase2-billing.sql',
  '../../../phase3-ai.sql',
  '../../../phase4-payroll.sql',
  '../../../phase4-performance.sql',
  '../../../phase4-benefits.sql',
  '../../../phase4-integrations.sql',
]

/** Deterministic dedicated-schema name for a tenant: `tn_` + sha256-of-id (32 hex chars). */
export function schemaNameForTenant(tenantId: string): string {
  return `tn_${sha256Hex(tenantId).slice(0, 32)}`
}

/**
 * Splits a SQL script into top-level statements, ignoring `;` inside single /
 * double-quoted strings and dollar-quoted bodies (the phase 0 RLS `DO $$`
 * block contains `;` inside `format()` string literals).
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  let dollar: string | null = null
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (dollar) {
      cur += ch
      if (sql.startsWith(dollar, i)) {
        cur += dollar
        i += dollar.length
        dollar = null
        continue
      }
      i += 1
      continue
    }
    if (inSingle) {
      cur += ch
      if (ch === "'") {
        if (next === "'") {
          // SQL-standard '' escape inside a string literal.
          cur += next
          i += 2
          continue
        }
        inSingle = false
      }
      i += 1
      continue
    }
    if (inDouble) {
      cur += ch
      if (ch === '"') inDouble = false
      i += 1
      continue
    }
    if (ch === "'") {
      inSingle = true
      cur += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inDouble = true
      cur += ch
      i += 1
      continue
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(sql.slice(i))?.[0]
      const open = tag ?? (sql.startsWith('$$', i) ? '$$' : null)
      if (open) {
        dollar = open
        cur += open
        i += open.length
        continue
      }
    }
    if (ch === ';') {
      const trimmed = cur.trim()
      if (trimmed) out.push(trimmed)
      cur = ''
      i += 1
      continue
    }
    cur += ch
    i += 1
  }
  const tail = cur.trim()
  if (tail) out.push(tail)
  return out
}

const CREATE_TABLE_RE = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/i
const CREATE_INDEX_RE = /^\s*CREATE\s+INDEX/i

interface ExtractedStatements {
  tables: Map<string, string>
  indexes: string[]
}

/** Keeps only `CREATE TABLE` / `CREATE INDEX` statements from a canonical source. */
function extractStatements(sql: string): ExtractedStatements {
  const stripped = sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
  const tables = new Map<string, string>()
  const indexes: string[] = []
  for (const stmt of splitSqlStatements(stripped)) {
    const m = CREATE_TABLE_RE.exec(stmt)
    if (m) {
      tables.set(m[1]!, stmt)
      continue
    }
    if (CREATE_INDEX_RE.test(stmt)) indexes.push(stmt)
  }
  return { tables, indexes }
}

/**
 * Rewrites every `REFERENCES <target>(...)` for the allowlisted GLOBAL_FK_TARGETS
 * into a `public.`-qualified reference (identifier-boundary, allowlist-only).
 * Already-qualified `public.<target> (` references are left untouched.
 */
export function rewriteGlobalFkTargets(sql: string): string {
  let out = sql
  for (const target of GLOBAL_FK_TARGETS) {
    const re = new RegExp(`\\bREFERENCES\\s+(?!public\\.)(${target})\\s*\\(`, 'gi')
    out = out.replace(re, 'REFERENCES public.$1 (')
  }
  return out
}

/**
 * Appends `DEFERRABLE INITIALLY IMMEDIATE` to one self-referential FK column
 * inside a single `CREATE TABLE` statement.
 */
export function makeSelfRefFksDeferrable(
  tableName: string,
  columnName: string,
  createStmt: string,
): string {
  const re = new RegExp(`(\\b${columnName}\\s+UUID\\s+REFERENCES\\s+${tableName}\\s*\\(id\\))`, 'i')
  return createStmt.replace(re, '$1 DEFERRABLE INITIALLY IMMEDIATE')
}

/**
 * Builds the complete materialized DDL for a dedicated tenant schema from the
 * canonical phase sources: the TENANT_SCOPED_TABLES with
 * `makeSelfRefFksDeferrable` + `rewriteGlobalFkTargets` applied, the derived
 * `<tn>.role_permissions` (role_id FK bound to `<tn>.roles`, permission_id to
 * `public.permissions`), and every canonical index. Executed under
 * `search_path = <tn>, public` (`public` second, so the two global FK targets
 * resolve). Same column order as the source by construction, which is what
 * makes the pinned checksum comparable across both sides.
 */
export async function buildDedicatedSchemaDdl(): Promise<string> {
  const tables = new Map<string, string>()
  const indexes: string[] = []
  for (const url of PHASE_SOURCES) {
    const source = transformSchema(await readFile(new URL(url, import.meta.url), 'utf8'))
    const extracted = extractStatements(source)
    for (const [name, stmt] of extracted.tables) {
      if (!tables.has(name)) tables.set(name, stmt)
    }
    indexes.push(...extracted.indexes)
  }
  // idempotency_keys lives in EXTRA_DDL (src/db/schema.ts), not a phase file.
  tables.set('idempotency_keys', transformSchema(EXTRA_DDL))

  const emitted: string[] = []
  for (const name of TENANT_SCOPED_TABLES) {
    const stmt = tables.get(name)
    if (!stmt) throw new Error(`dedicated-schema: canonical DDL missing for tenant table "${name}"`)
    let s = stmt
    for (const col of SELF_REFERENTIAL_FKS[name] ?? []) {
      s = makeSelfRefFksDeferrable(name, col, s)
    }
    s = rewriteGlobalFkTargets(s)
    // `IF NOT EXISTS` makes re-materialization after a crash mid-pass
    // idempotent: existing relations are skipped, missing ones are created.
    emitted.push(s.replace(/^\s*CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE TABLE IF NOT EXISTS '))
  }

  const rolePermissions = tables.get('role_permissions')
  if (!rolePermissions) {
    throw new Error('dedicated-schema: canonical role_permissions DDL missing from phase0-1-schema.sql')
  }
  emitted.push(
    rewriteGlobalFkTargets(rolePermissions).replace(/^\s*CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE TABLE IF NOT EXISTS '),
  )

  const body = emitted.join(';\n\n')
  const idx = indexes
    .map((s) => rewriteGlobalFkTargets(s))
    .map((s) => s.replace(/^\s*CREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE INDEX IF NOT EXISTS '))
    .join(';\n\n')
  return `CREATE EXTENSION IF NOT EXISTS vector;\n\n${body}${idx ? `;\n\n${idx}` : ''}`
}

// ---------------------------------------------------------------------------
// Pinned checksum + manifest / verification queries
// ---------------------------------------------------------------------------

export interface TableChecksum {
  count: number
  checksum: string
}

/**
 * The pinned, extension-free checksum: count(*) AND
 * md5(coalesce(string_agg(md5(t::text), '' ORDER BY t::text), '')).
 * The exact same SQL text is used on both sides — the Step 0 manifest over
 * `public` with a tenant filter, and the Step 3 verify over `<tn>` without —
 * so the two aggregates are directly comparable. Per-row md5(t::text) is a
 * fixed 32-char hex string and `ORDER BY t::text` is a total order on distinct
 * rows, making concatenation delimiter-ambiguous-proof.
 */
export const CHECKSUM_FRAGMENT =
  `count(*)::int AS "count", ` +
  `md5(coalesce(string_agg(md5(t::text), '' ORDER BY t::text), '')) AS "checksum"`

/**
 * Builds the checksum SELECT for one table. `schemaName` is asserted either
 * 'public' (manifest side, tenant-filtered) or a derived `tn_` name (verify
 * side, no filter). `asRolePermissions` selects the join-filtered row set used
 * for the derived `<tn>.role_permissions`.
 */
export function checksumSql(
  table: string,
  schemaName: string,
  tenantId?: string,
  asRolePermissions = false,
): { sql: string; params: unknown[] } {
  assertSchemaName(schemaName)
  const tableRef = schemaName === 'public' ? `public.${table}` : `"${schemaName}"."${table}"`
  const auditExcluder = table === 'audit_logs' ? ` AND ${MIGRATION_AUDIT_EXCLUDER}` : ''
  if (schemaName === 'public') {
    if (asRolePermissions) {
      return {
        sql: `SELECT ${CHECKSUM_FRAGMENT}
              FROM public.role_permissions t
              WHERE t.role_id IN (SELECT r.id FROM public.roles r WHERE r.tenant_id = $1)`,
        params: [tenantId],
      }
    }
    return {
      sql: `SELECT ${CHECKSUM_FRAGMENT}
            FROM ${tableRef} t
            WHERE t.tenant_id = $1${auditExcluder}`,
      params: [tenantId],
    }
  }
  return {
    sql: `SELECT ${CHECKSUM_FRAGMENT}
          FROM ${tableRef} t
          WHERE true${auditExcluder}`,
    params: [],
  }
}

/** The join-filtered copy for a dedicated tenant's role_permissions (mirrors the manifest filter). */
export function rolePermissionsCopySql(
  schemaName: string,
  tenantId: string,
): { sql: string; params: unknown[] } {
  assertSchemaName(schemaName)
  return {
    sql: `INSERT INTO "${schemaName}".role_permissions (role_id, permission_id)
          SELECT rp.role_id, rp.permission_id
          FROM public.role_permissions rp
          WHERE rp.role_id IN (SELECT id FROM public.roles WHERE tenant_id = $1)`,
    params: [tenantId],
  }
}

/**
 * The dedicated-tier platform's own audit event names. These rows are written
 * into `public.audit_logs` by the migration state machine (they are platform
 * operations, not tenant module history — see PHASE5-DEDICATED-TIER-DESIGN.md
 * §8.1), so they can land between the Step 0 manifest freeze and the Step 2
 * copy. They are excluded — by the SAME explicit list of action names — from
 * the manifest/verify checksums (both sides, identical SQL text) and from the
 * `audit_logs` copy, keeping the parity comparison stable and the dedicated
 * snapshot a pure picture of the tenant's module history.
 */
export const MIGRATION_PLATFORM_AUDIT_ACTIONS: readonly string[] = [
  'schema_created',
  'copy_completed',
  'verified',
  'verify_failed',
  'cutover',
  'purged',
  'aborted',
  'rolled_back',
]

/** SQL fragment excluding migration-platform audit rows (identity by action name). */
const MIGRATION_AUDIT_EXCLUDER = `t.action NOT IN (${MIGRATION_PLATFORM_AUDIT_ACTIONS.map((a) => `'${a}'`).join(', ')})`

/**
 * Per-role mapping snapshots for parity checks, keyed by role_id with Mappings
 * ordered by permission_id. `schemaName` selects which side to read.
 */
export function rolePermissionsParity(
  schemaName: string,
  tenantId?: string,
): { sql: string; params: unknown[] } {
  assertSchemaName(schemaName)
  const from =
    schemaName === 'public'
      ? `public.role_permissions rp
           WHERE rp.role_id IN (SELECT r.id FROM public.roles r WHERE r.tenant_id = $1)`
      : `"${schemaName}".role_permissions rp`
  return {
    sql: `SELECT rp.role_id::text AS "roleId",
                 string_agg(rp.permission_id::text, ',' ORDER BY rp.permission_id::text) AS "mappings",
                 count(*)::int AS "n"
          FROM ${from}
          GROUP BY rp.role_id
          ORDER BY rp.role_id::text`,
    params: schemaName === 'public' && tenantId ? [tenantId] : [],
  }
}

/**
 * Step 1 catalog assertion over a fresh dedicated schema: exactly the
 * TENANT_SCOPED_TABLES + the derived role_permissions; no `tenants` /
 * `permissions` objects; role_permissions FKs bound to `<tn>.roles` and
 * `public.permissions` exactly once each; every non-tenant-table FK target
 * resolves in `public`; the only DEFERRABLE constraints are the two
 * self-references. Throws with the offending detail otherwise.
 */
export async function assertDedicatedSchemaCatalog(
  exec: SqlExecutor,
  schemaName: string,
): Promise<void> {
  assertSchemaName(schemaName)

  const rel = await exec.query<{ name: string; kind: string }>(
    `SELECT c.relname AS "name", c.relkind AS "kind"
     FROM pg_class c
     WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r', 'p', 'f')
     ORDER BY c.relname`,
    [schemaName],
  )
  const relNames = rel.rows.map((r) => r.name)
  const tenants = ['tenants', 'permissions'].filter((n) => relNames.includes(n))
  if (tenants.length > 0) {
    throw new Error(`catalog assertion failed: global object(s) present in ${schemaName}: ${tenants.join(', ')}`)
  }
  const expected = [...TENANT_SCOPED_TABLES, 'role_permissions'].sort()
  const actual = [...relNames].sort()
  if (expected.length !== actual.length || expected.some((n, i) => n !== actual[i])) {
    const missing = expected.filter((n) => !actual.includes(n))
    const extra = actual.filter((n) => !expected.includes(n))
    throw new Error(
      `catalog assertion failed: expected ${expected.length} tables, found ${actual.length}` +
        (missing.length ? `; missing: ${missing.join(', ')}` : '') +
        (extra.length ? `; extra: ${extra.join(', ')}` : ''),
    )
  }

  const fks = await exec.query<{
    table: string
    column: string
    refSchema: string
    refTable: string
    deferrable: boolean
  }>(
    `SELECT conrelid::regclass::text AS "table",
            a.attname AS "column",
            n2.nspname AS "refSchema",
            c2.relname AS "refTable",
            condeferrable AS "deferrable"
     FROM pg_constraint c
     JOIN pg_class c1 ON c1.oid = c.conrelid
     JOIN pg_class c2 ON c2.oid = c.confrelid
     JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
     JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND n1.nspname = $1
       AND c.confkey IS NOT NULL
     ORDER BY c1.relname, c.conname`,
    [schemaName],
  )

  const rpFks = fks.rows.filter((f) => {
    const bare = f.table.includes('.') ? f.table.slice(f.table.indexOf('.') + 1) : f.table
    return bare === 'role_permissions'
  })
  if (rpFks.length !== 2) {
    throw new Error(`catalog assertion failed: role_permissions has ${rpFks.length} FKs, expected exactly 2`)
  }
  const rpToRoles = rpFks.find((f) => f.refSchema === schemaName && f.refTable === 'roles')
  const rpToPermissions = rpFks.find((f) => f.refSchema === 'public' && f.refTable === 'permissions')
  if (!rpToRoles || !rpToPermissions) {
    throw new Error(
      `catalog assertion failed: role_permissions FKs must bind <tn>.roles + public.permissions —
       actual: ${rpFks.map((f) => `${f.refSchema}.${f.refTable}`).join(', ')}`,
    )
  }

  for (const fk of fks.rows) {
    if (!['public', schemaName].includes(fk.refSchema)) {
      throw new Error(
        `catalog assertion failed: FK ${fk.table}.${fk.column} targets foreign schema "${fk.refSchema}"`,
      )
    }
    const bareTable = fk.table.includes('.') ? fk.table.slice(fk.table.indexOf('.') + 1) : fk.table
    if (fk.deferrable && !(SELF_REFERENTIAL_FKS[bareTable]?.includes(fk.column))) {
      throw new Error(
        `catalog assertion failed: unexpected DEFERRABLE constraint ${fk.table}.${fk.column}`,
      )
    }
  }

  const deferrables = fks.rows.filter((f) => f.deferrable)
  const expectedDeferrables = Object.entries(SELF_REFERENTIAL_FKS).flatMap(([t, cols]) =>
    cols.map((c) => `${t}.${c}`),
  )
  if (
    deferrables.length !== expectedDeferrables.length ||
    deferrables.some(
      (f) => {
        const bare = f.table.includes('.') ? f.table.slice(f.table.indexOf('.') + 1) : f.table
        return !expectedDeferrables.includes(`${bare}.${f.column}`)
      },
    )
  ) {
    throw new Error(
      `catalog assertion failed: expected exactly the self-referential DEFERRABLE constraints [${expectedDeferrables.join('; ')}], ` +
        `found [${deferrables.map((f) => `${f.table}.${f.column}`).join('; ')}]`,
    )
  }
}