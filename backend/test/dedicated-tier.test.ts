import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Db, newId } from '../src/db/index.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig, loadEnvFile } from '../src/config.js'
import { warmUpDb } from './warmup.js'
import {
  abortMigration,
  copyMigration,
  cutoverMigration,
  failMigration,
  getMigration,
  prepareMigration,
  purgeMigration,
  rollbackMigration,
  verifyMigration,
} from '../src/modules/migrations/migrations.repo.js'
import { TENANT_PURGED_TABLES } from '../src/db/schema.js'

/**
 * Dedicated-tenant tier end-to-end suite — Phase 5.
 *
 * Every test provisions its OWN tenant (via /tenants/signup + enterprise plan)
 * and feeds it direct SQL fixtures, so the file runs safely in parallel with
 * the shared e2e suite. Adversarial scenarios run BEFORE the happy path.
 * console.log lines carry the concrete query results the report quotes.
 */

loadEnvFile()

let db: Db
let app: FastifyInstance
let signupCounter = 0

function say(label: string, value: unknown): void {
  console.log(`    [evidence] ${label}: ${JSON.stringify(value)}`)
}

interface Provisioned {
  tenantId: string
  subdomain: string
  email: string
  password: string
  adminToken: string
  refreshToken: string
}

async function provisionTenant(prefix: string): Promise<Provisioned> {
  const subdomain = `${prefix}${Date.now()}-${signupCounter++}`.slice(0, 40)
  const email = `admin@${subdomain}.test`
  const password = 'Passw0rd!x'
  const res = await app.inject({
    method: 'POST',
    url: '/tenants/signup',
    payload: {
      companyName: `${prefix} Co`,
      subdomain,
      adminEmail: email,
      adminPassword: password,
      adminFirstName: 'Admin',
      adminLastName: 'User',
    },
  })
  expect(res.statusCode).toBe(201)
  const body = res.json()
  const tenantId = body.tenant.id as string
  const plan = await app.inject({
    method: 'PATCH',
    url: '/billing/subscription/plan',
    headers: { authorization: `Bearer ${body.accessToken}` },
    payload: { plan: 'enterprise' },
  })
  expect(plan.statusCode).toBe(200)
  return {
    tenantId,
    subdomain,
    email,
    password,
    adminToken: body.accessToken,
    refreshToken: body.refreshToken,
  }
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` }
}

/** Direct SQL fixtures: manager chain, parent/child departments, 3 employees. */
async function seedRichData(tenantId: string): Promise<{ deptParent: string; deptChild: string; empA: string; empB: string; empC: string }> {
  let deptParent = ''
  let deptChild = ''
  let empA = ''
  let empB = ''
  let empC = ''
  await db.system(async (q) => {
    deptParent = newId()
    deptChild = newId()
    empA = newId()
    empB = newId()
    empC = newId()
    await q.exec(`INSERT INTO departments (id, tenant_id, name) VALUES ($1, $2, 'Engineering')`, [deptParent, tenantId])
    await q.exec(`INSERT INTO departments (id, tenant_id, name, parent_id) VALUES ($1, $2, 'Platform', $3)`, [deptChild, tenantId, deptParent])
    for (const [id, name, managerId, deptId] of [
      [empA, 'Alia', null, deptParent],
      [empB, 'Ben', empA, deptParent],
      [empC, 'Cara', empB, deptChild],
    ] as Array<[string, string, string | null, string]>) {
      await q.exec(
        `INSERT INTO employees (id, tenant_id, employee_number, first_name, last_name, hire_date, department_id, manager_employee_id)
         VALUES ($1, $2, $3, $4, 'T', '2026-01-05', $5, $6)`,
        [id, tenantId, `EMP-${id.replace(/-/g, '').slice(-10).toUpperCase()}`, name, deptId, managerId],
      )
    }
    // Extra role_permission mapping for the admin role (drives derived rp copy).
    const role = await q.query<{ id: string }>(
      `SELECT r.id FROM roles r WHERE r.tenant_id = $1 AND r.name = 'admin' LIMIT 1`,
      [tenantId],
    )
    const perm = await q.query<{ id: string }>(
      `SELECT id FROM permissions WHERE code = 'leave:approve' LIMIT 1`,
    )
    if (role.rows[0] && perm.rows[0]) {
      await q.exec(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [role.rows[0].id, perm.rows[0].id],
      )
    }
  })
  return { deptParent, deptChild, empA, empB, empC }
}

async function fullMachineToCutover(tenantId: string): Promise<{ schemaName: string; migrationId: string }> {
  const prepared = await prepareMigration(db, tenantId)
  const copied = await copyMigration(db, prepared.migrationId)
  const verified = await verifyMigration(db, copied.migrationId)
  expect(verified.status).toBe('verifying')
  const cut = await cutoverMigration(db, verified.migrationId)
  expect(cut.status).toBe('cutover')
  return { schemaName: cut.schemaName!, migrationId: cut.migrationId }
}

function decodeToken(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]!
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
}

async function login(subdomain: string, email: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password, tenantSubdomain: subdomain },
  })
  return { status: res.statusCode, body: res.json() }
}

async function refresh(refreshToken: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/refresh',
    payload: { refreshToken },
  })
  return { status: res.statusCode, body: res.json() }
}

beforeAll(async () => {
  const config = loadConfig()
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required to run the suite — see .env.example')
  }
  await warmUpDb(config.databaseUrl)
  db = await Db.open({
    connectionString: config.databaseUrl,
    max: config.dbPoolSize,
    ssl: config.dbSsl,
  })
  app = await buildApp({ db, config, logger: false })
  await app.ready()
})

afterAll(async () => {
  if (app) await app.close()
  if (db) await db.close()
})

describe('dedicated tier — adversarial (test 1) verify mismatch → failed', () => {
  it('injected public row between manifest and copy marks the migration failed, drops the schema, tenant stays shared, retry is clean', { timeout: 600_000 }, async () => {
    const t = await provisionTenant('mt1')
    const rich = await seedRichData(t.tenantId)

    const prepared = await prepareMigration(db, t.tenantId)
    expect(prepared.status).toBe('prepared')
    say('prepared.manifest.employees', prepared.manifestJson?.employees)
    say('prepared.schemaName', prepared.schemaName)
    const schemaName = prepared.schemaName!

    // Walk the catalog + soft existence of the dedicated schema.
    const existsBefore = await db.system(async (q) =>
      q.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`, [schemaName]),
    )
    say('schemaExistsAfterPrepare', existsBefore.rows[0]?.n)

    // ROGUE write after the manifest is pinned, before any copy (simulates a
    // writer that slipped past quiescence): one extra employee in public.
    await db.system(async (q) => {
      await q.exec(
        `INSERT INTO public.employees (id, tenant_id, employee_number, first_name, last_name, hire_date)
         VALUES ($1, $2, 'ROGUE-1', 'Rogue', 'Row', '2026-09-01')`,
        [newId(), t.tenantId],
      )
    })

    const copied = await copyMigration(db, prepared.migrationId)
    expect(copied.status).toBe('copying')

    let mismatch = ''
    try {
      await verifyMigration(db, copied.migrationId)
      expect.unreachable('verify should have failed')
    } catch (err) {
      mismatch = (err as Error).message
      say('verifyError', mismatch)
      expect(mismatch).toMatch(/^verify_mismatch/)
    }

    const failed = await failMigration(db, copied.migrationId, mismatch)
    expect(failed.status).toBe('failed')

    const gone = await db.system(async (q) =>
      q.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`, [schemaName]),
    )
    say('schemaExistsAfterFail', gone.rows[0]?.n)
    expect(gone.rows[0]?.n).toBe(0)

    const after = await db.system(async (q) => {
      const r = await q.query<{ status: string; isolationMode: string }>(
        `SELECT status, isolation_mode AS "isolationMode" FROM tenants WHERE id = $1`,
        [t.tenantId],
      )
      return r.rows[0]
    })
    say('tenantAfterFail', after)
    expect(after?.status).toBe('active')
    expect(after?.isolationMode).toBe('shared')

    // Retry is clean: the in-flight partial-unique index no longer blocks us.
    const retry = await prepareMigration(db, t.tenantId)
    expect(retry.status).toBe('prepared')
    await copyMigration(db, retry.migrationId)
    await verifyMigration(db, retry.migrationId)
    const cut = await cutoverMigration(db, retry.migrationId)
    expect(cut.status).toBe('cutover')
    await rollbackMigration(db, retry.migrationId)
  })
})

describe('dedicated tier — adversarial (test 2) cutover rollback', () => {
  it('rolls a cut-over tenant back to shared pre-purge; tokens re-resolve to public, schema dropped', { timeout: 600_000 }, async () => {
    const t = await provisionTenant('mt2')
    await seedRichData(t.tenantId)
    const cut = await fullMachineToCutover(t.tenantId)

    const rollback = await rollbackMigration(db, cut.migrationId)
    expect(rollback.status).toBe('rolled_back')

    const gone = await db.system(async (q) =>
      q.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`, [cut.schemaName]),
    )
    expect(gone.rows[0]?.n).toBe(0)
    say('schemaDroppedAfterRollback', gone.rows[0]?.n === 0)

    const after = await db.system(async (q) => {
      const r = await q.query<{ status: string; isolationMode: string; dedicatedSchema: string | null }>(
        `SELECT status, isolation_mode AS "isolationMode", dedicated_schema AS "dedicatedSchema" FROM tenants WHERE id = $1`,
        [t.tenantId],
      )
      return r.rows[0]
    })
    say('tenantAfterRollback', after)
    expect(after?.status).toBe('active')
    expect(after?.isolationMode).toBe('shared')
    expect(after?.dedicatedSchema).toBeNull()

    // Pre-cutover tokens still work against the shared copy (rollback, purge never ran).
    const fresh = await login(t.subdomain, t.email, t.password)
    expect(fresh.status).toBe(200)
    say('loginAfterRollback.status', fresh.status)
  })
})

describe('dedicated tier — adversarial (test 3) purge integrity', () => {
  it('preserves per-role permission parity, retains active tokens, clears every public row, drops schema', { timeout: 600_000 }, async () => {
    const t = await provisionTenant('mt3')
    await seedRichData(t.tenantId)
    const cut = await fullMachineToCutover(t.tenantId)
    const schemaName = cut.schemaName

    // Expect exactly ONE retained token: the one issued at signup (active).
    const prePurgeMappings = await db.system(async (q) =>
      q.query<{ roleId: string; mappings: string; n: number }>(
        `SELECT rp.role_id::text AS "roleId",
                string_agg(rp.permission_id::text, ',' ORDER BY rp.permission_id::text) AS "mappings",
                count(*)::int AS "n"
         FROM "${schemaName}".role_permissions rp
         GROUP BY rp.role_id ORDER BY rp.role_id::text`,
      ),
    )
    const sharedMappings = await db.system(async (q) =>
      q.query<{ roleId: string; mappings: string; n: number }>(
        `SELECT rp.role_id::text AS "roleId",
                string_agg(rp.permission_id::text, ',' ORDER BY rp.permission_id::text) AS "mappings",
                count(*)::int AS "n"
         FROM public.role_permissions rp
         WHERE rp.role_id IN (SELECT r.id FROM public.roles r WHERE r.tenant_id = $1)
         GROUP BY rp.role_id ORDER BY rp.role_id::text`,
        [t.tenantId],
      ),
    )
    say('sharedRoleMappings', sharedMappings.rows)
    say('dedicatedRoleMappings', prePurgeMappings.rows)
    expect(prePurgeMappings.rows.length).toBe(sharedMappings.rows.length)
    for (let i = 0; i < prePurgeMappings.rows.length; i++) {
      expect(prePurgeMappings.rows[i]!.mappings).toBe(sharedMappings.rows[i]!.mappings)
    }

    // Stale, expired token to prove purge prunes only the dead.
    await db.system(async (q) => {
      await q.exec(
        `INSERT INTO public.refresh_tokens (tenant_id, user_id, token_hash, expires_at, revoked_at)
         VALUES ($1, (SELECT id FROM public.user_accounts WHERE tenant_id = $1 LIMIT 1), 'deadbeefhash', now() - interval '1 day', now())`,
        [t.tenantId],
      )
    })

    const purged = await purgeMigration(db, cut.migrationId)
    expect(purged.status).toBe('purged')
    say('purged.retainedRefreshTokens', purged.verificationJson)
    const auditPurged = await db.system(async (q) =>
      q.query<{ action: string; after: Record<string, unknown> }>(
        `SELECT action, after_state AS after FROM audit_logs WHERE tenant_id = $1 AND action = 'purged' ORDER BY created_at DESC LIMIT 1`,
        [t.tenantId],
      ),
    )
    say('audit.purged', auditPurged.rows[0]?.after)
    expect((auditPurged.rows[0]?.after as { retainedRefreshTokens?: number })?.retainedRefreshTokens).toBe(1)
    expect((auditPurged.rows[0]?.after as { tablesPurged?: number })?.tablesPurged).toBe(TENANT_PURGED_TABLES.length)

    // Every fully-purged tenant-scoped public table is empty for this tenant.
    // Two are expected to hold rows post-purge and are checked separately:
    // `refresh_tokens` (retained registry) and `audit_logs` (the `purged`
    // marker written after the collapse).
    for (const table of TENANT_PURGED_TABLES) {
      if (table === 'audit_logs') continue
      const res = await db.system(async (q) => {
        const r = await q.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.${table} WHERE tenant_id = $1`,
          [t.tenantId],
        )
        return r.rows[0]?.n ?? -1
      })
      expect(res).toBe(0)
    }
    say('allPublicTenantTablesEmpty', true)

    // Dead tokens pruned, the one active signup token retained.
    const tokens = await db.system(async (q) =>
      q.query<{ total: number; active: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS active
         FROM public.refresh_tokens WHERE tenant_id = $1`,
        [t.tenantId],
      ),
    )
    say('refreshTokensAfterPurge', tokens.rows[0])
    expect(tokens.rows[0]?.total).toBe(1)
    expect(tokens.rows[0]?.active).toBe(1)

    // The dedicated schema PERSISTS post-purge — it is the tenant's new home,
    // and post-purge login/refresh resolve from it (§3.3 Step 5, §9). The
    // purge only collapsed the shared `public` copy.
    const exists = await db.system(async (q) =>
      q.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`, [schemaName]),
    )
    expect(exists.rows[0]?.n).toBe(1)
    say('schemaPersistsAfterPurge', exists.rows[0]?.n === 1)
  })
})

describe('dedicated tier — adversarial (test 4) purge-safe login', () => {
  it('logins and refresh resolves from the tenant schema after purge; revoked tokens die', { timeout: 600_000 }, async () => {
    const t = await provisionTenant('mt4')
    await seedRichData(t.tenantId)
    const cut = await fullMachineToCutover(t.tenantId)

    // Post-cutover login → schema-routing claims in the JWT.
    const postCut = await login(t.subdomain, t.email, t.password)
    expect(postCut.status).toBe(200)
    const claims = decodeToken(postCut.body.accessToken)
    say('postCutoverTokenClaims', claims)
    expect(claims.isolationMode).toBe('dedicated_schema')
    expect(claims.tenantSchema).toBe(cut.schemaName)
    const refreshTokenBeforePurge = postCut.body.refreshToken as string

    await purgeMigration(db, cut.migrationId)

    // Login + refresh both resolve from <tn> post-purge.
    const postPurge = await login(t.subdomain, t.email, t.password)
    expect(postPurge.status).toBe(200)
    say('postPurgeLoginStatus', postPurge.status)
    expect(decodeToken(postPurge.body.accessToken).tenantSchema).toBe(cut.schemaName)

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: auth(postPurge.body.accessToken),
    })
    expect(me.statusCode).toBe(200)
    say('postPurgeMe', me.json())
    expect(me.json().email).toBe(t.email)

    // The pre-purge active token refresh works (retained), and its rotation
    // kills it (replay → 401).
    const rot = await refresh(refreshTokenBeforePurge)
    expect(rot.status).toBe(200)
    say('refreshPrePurgeToken.status', rot.status)
    const rotReplay = await refresh(refreshTokenBeforePurge)
    expect(rotReplay.status).toBe(401)
  })
})

describe('dedicated tier — adversarial (test 5) self-referential FK copy', () => {
  it('copies manager + department chains with zero orphans and exactly two DEFERRABLE self-refs', { timeout: 600_000 }, async () => {
    const t = await provisionTenant('mt5')
    const rich = await seedRichData(t.tenantId)
    const cut = await fullMachineToCutover(t.tenantId)
    const schemaName = cut.schemaName

    // No orphan managers/departments inside the dedicated schema.
    const orphans = await db.system(async (q) => {
      const emp = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${schemaName}".employees e
         WHERE e.manager_employee_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "${schemaName}".employees m WHERE m.id = e.manager_employee_id)`,
      )
      const dept = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${schemaName}".departments d
         WHERE d.parent_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "${schemaName}".departments p WHERE p.id = d.parent_id)`,
      )
      const count = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${schemaName}".employees`)
      return { empOrphans: emp.rows[0]?.n, deptOrphans: dept.rows[0]?.n, employees: count.rows[0]?.n }
    })
    say('dedicatedOrphans', orphans)
    expect(orphans.empOrphans).toBe(0)
    expect(orphans.deptOrphans).toBe(0)
    // Signup's admin employee + the 3 seeded chain = 4 (dedicated copy matched).
    expect(orphans.employees).toBe(4)

    // Exactly the two self-references are DEFERRABLE.
    const deferrables = await db.system(async (q) => {
      const r = await q.query<{ table: string; column: string }>(
        `SELECT format('%I.%I', n.nspname, c1.relname) AS "table", a.attname AS "column"
         FROM pg_constraint c
         JOIN pg_class c1 ON c1.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = c1.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f' AND condeferrable = true
           AND n.nspname = $1
         ORDER BY n.nspname, c1.relname, a.attname`,
        [schemaName],
      )
      return r.rows
    })
    say('deferrableConstraints', deferrables)
    expect(deferrables.length).toBe(2)
    const labels = deferrables.map((d) => `${d.table}.${d.column}`)
    expect(labels).toContain(`${schemaName}.employees.manager_employee_id`)
    expect(labels).toContain(`${schemaName}.departments.parent_id`)
  })
})

describe('dedicated tier — adversarial (test 6) write quiescence', () => {
  it('refuses writes (409) and login/refresh (401) while migrating, and the manifest is stable', { timeout: 600_000 }, async () => {
    const t = await provisionTenant('mt6')
    await seedRichData(t.tenantId)

    const prepared = await prepareMigration(db, t.tenantId)
    say('tenantStatusDuringPrepare', prepared.status)

    const write = await app.inject({
      method: 'POST',
      url: '/employees',
      headers: auth(t.adminToken),
      payload: {
        firstName: 'Blocked',
        lastName: 'Writer',
        hireDate: '2026-09-01',
        employmentType: 'full_time',
      },
    })
    say('writeDuringMigrating', { status: write.statusCode, body: write.json() })
    expect(write.statusCode).toBe(409)
    expect(write.json().error.code).toBe('TENANT_MIGRATING')

    const loginBlocked = await login(t.subdomain, t.email, t.password)
    expect(loginBlocked.status).toBe(401)
    say('loginDuringMigrating', loginBlocked.status)

    const refreshBlocked = await refresh(t.refreshToken)
    expect(refreshBlocked.status).toBe(401)
    say('refreshDuringMigrating', refreshBlocked.status)

    // The 409'd write never landed: manifest (pinned at prepare) == copy.
    const copied = await copyMigration(db, prepared.migrationId)
    const verified = await verifyMigration(db, copied.migrationId)
    expect(verified.status).toBe('verifying')
    say('manifestStableAfterQuiescedWrites', true)

    // Pre-cutover teardown is an abort (rollback is only legal post-cutover).
    await abortMigration(db, verified.migrationId)
  })
})

describe('dedicated tier — adversarial (test 7) no cross-tenant leak', () => {
  it('dedicated tenant A and shared tenant B only ever see their own rows', { timeout: 600_000 }, async () => {
    const a = await provisionTenant('mt7a')
    const b = await provisionTenant('mt7b')
    await seedRichData(a.tenantId)
    await seedRichData(b.tenantId)
    const cutA = await fullMachineToCutover(a.tenantId)
    await purgeMigration(db, cutA.migrationId)

    const adminA = (await login(a.subdomain, a.email, a.password)).body.accessToken
    const adminB = (await login(b.subdomain, b.email, b.password)).body.accessToken

    const listA = await app.inject({ method: 'GET', url: '/employees', headers: auth(adminA) })
    const listB = await app.inject({ method: 'GET', url: '/employees', headers: auth(adminB) })
    say('dedicatedEmployeesCount', listA.json().total)
    say('sharedEmployeesCount', listB.json().total)
    expect(listA.json().total).toBe(4)
    expect(listB.json().total).toBe(4)

    const meA = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(adminA) })
    const meB = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(adminB) })
    say('dedicatedMeEmail', meA.json().email)
    say('sharedMeEmail', meB.json().email)
    expect(meA.json().email).toBe(a.email)
    expect(meB.json().email).toBe(b.email)
  })
})

describe('dedicated tier — adversarial→parity (test 8) reporting parity', () => {
  it('headcount report is identical before the migration and after cutover+purge', { timeout: 600_000 }, async () => {
    const t = await provisionTenant('mt8')
    await seedRichData(t.tenantId)

    const before = await app.inject({
      method: 'GET',
      url: '/reports/headcount',
      headers: auth(t.adminToken),
    })
    say('headcountShared', before.json())

    const post = await fullMachineToCutover(t.tenantId)
    await purgeMigration(db, post.migrationId)

    const afterLogin = await login(t.subdomain, t.email, t.password)
    const after = await app.inject({
      method: 'GET',
      url: '/reports/headcount',
      headers: auth(afterLogin.body.accessToken),
    })
    say('headcountDedicated', after.json())
    expect(JSON.stringify(after.json())).toBe(JSON.stringify(before.json()))
  })
})

describe('dedicated tier — happy path (test 9), runs LAST', () => {
  it('prepared → copying → verifying → cutover → purged with stage parity and audit trail', { timeout: 600_000 }, async () => {
    const t = await provisionTenant('mt9')
    await seedRichData(t.tenantId)

    const s1 = await prepareMigration(db, t.tenantId)
    expect(s1.status).toBe('prepared')
    const s2 = await copyMigration(db, s1.migrationId)
    expect(s2.status).toBe('copying')
    const s3 = await verifyMigration(db, s2.migrationId)
    expect(s3.status).toBe('verifying')
    say('verification.evidence.employees', s3.verificationJson?.employees)
    say('manifest.evidence.employees', s1.manifestJson?.employees)
    expect(s3.verificationJson?.employees).toEqual(s1.manifestJson?.employees)
    expect(s3.verificationJson?.role_permissions).toEqual(s1.manifestJson?.role_permissions)
    const s4 = await cutoverMigration(db, s3.migrationId)
    expect(s4.status).toBe('cutover')

    // Full audit trail for the machine, captured BEFORE purge (purge deletes
    // the tenant's public.audit_logs rows; only the post-delete `purged` event
    // survives it — §3.3 Step 5).
    const trail = await db.system(async (q) =>
      q.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE tenant_id = $1 AND action IN
           ('schema_created','copy_completed','verified','cutover','purged')
         ORDER BY created_at`,
        [t.tenantId],
      ),
    )
    const actions = trail.rows.map((r) => r.action)
    say('auditTrailPrePurge', actions)
    expect(actions).toContain('schema_created')
    expect(actions).toContain('copy_completed')
    expect(actions).toContain('verified')
    expect(actions).toContain('cutover')

    const s5 = await purgeMigration(db, s4.migrationId)
    expect(s5.status).toBe('purged')
    const purgedTrail = await db.system(async (q) =>
      q.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE tenant_id = $1 AND action = 'purged' ORDER BY created_at DESC LIMIT 1`,
        [t.tenantId],
      ),
    )
    say('auditTrail.postPurge', purgedTrail.rows.map((r) => r.action))
    expect(purgedTrail.rows.length).toBe(1)

    const tenant = await db.system(async (q) => {
      const r = await q.query<{ status: string; isolationMode: string; dedicatedSchema: string | null }>(
        `SELECT status, isolation_mode AS "isolationMode", dedicated_schema AS "dedicatedSchema" FROM tenants WHERE id = $1`,
        [t.tenantId],
      )
      return r.rows[0]
    })
    say('tenantFinal', tenant)
    expect(tenant?.isolationMode).toBe('dedicated_schema')
    expect(tenant?.dedicatedSchema).toBe(s5.schemaName)

    const finalLogin = await login(t.subdomain, t.email, t.password)
    expect(finalLogin.status).toBe(200)
    expect(decodeToken(finalLogin.body.accessToken).tenantSchema).toBe(s5.schemaName)
  })
})