import type { Q, Db } from '../db/index.js'
import { scryptHash } from '../lib/crypto.js'
import { PERMISSION_CODES, SYSTEM_ROLES } from '../modules/permissions.js'

export const SEED = {
  TENANT_ACME: '11111111-1111-4111-8111-111111111111',
  TENANT_GLOBEX: '22222222-2222-4222-8222-222222222222',

  USER_ADMIN: 'a0000000-0000-4000-8000-000000000001',
  USER_PRIYA: 'a0000000-0000-4000-8000-000000000002',
  USER_AISHA: 'a0000000-0000-4000-8000-000000000003',
  USER_GLOBEX: 'a0000000-0000-4000-8000-000000000004',

  EMP_ADMIN: 'e0000000-0000-4000-8000-000000000001',
  EMP_PRIYA: 'e0000000-0000-4000-8000-000000000002',
  EMP_AISHA: 'e0000000-0000-4000-8000-000000000003',
  EMP_GLOBEX: 'e0000000-0000-4000-8000-000000000004',

  /** Marcus Webb — the hand-written Acme employee that exercises the API off the
   *  mockup's exact roster (a "Marcus Webb" appears in the employee list mockup;
   *  see the hand-written INSERT in seedAcme). Not part of the Acme admin trio. */
  EMP_MARCUS: 'e0000000-0000-4000-8000-000000000005',

  DEPT_DESIGN: 'd0000000-0000-4000-8000-000000000001',
  DEPT_ENG: 'd0000000-0000-4000-8000-000000000002',
  DEPT_FIN: 'd0000000-0000-4000-8000-000000000003',

  LOC_LHR: '10d00000-0000-4000-8000-000000000001',
  LOC_LDN: '10d00000-0000-4000-8000-000000000002',

  LEAVE_ANNUAL: '1aa00000-0000-4000-8000-000000000001',
  LEAVE_SICK: '1aa00000-0000-4000-8000-000000000002',
  LEAVE_PERSONAL: '1aa00000-0000-4000-8000-000000000003',
  LEAVE_ANNUAL_GLOBEX: '1aa00000-0000-4000-8000-000000000004',
} as const

interface SeedUser {
  id: string
  email: string
  password: string
  roles: (keyof typeof SYSTEM_ROLES)[]
}

const ACME_USERS: SeedUser[] = [
  { id: SEED.USER_ADMIN, email: 'admin@acme.com', password: 'admin123', roles: ['admin', 'employee'] },
  { id: SEED.USER_PRIYA, email: 'priya@acme.com', password: 'manager123', roles: ['manager', 'employee'] },
  { id: SEED.USER_AISHA, email: 'aisha@acme.com', password: 'employee123', roles: ['employee'] },
]

const GLOBEX_USERS: SeedUser[] = [
  { id: SEED.USER_GLOBEX, email: 'admin@globex.com', password: 'admin123', roles: ['admin', 'employee'] },
]

const GMT = 'T00:00:00Z'

async function seedPermissions(q: Q): Promise<Record<string, string>> {
  await q.exec(
    `INSERT INTO permissions (id, code)
     SELECT gen_random_uuid(), code FROM unnest($1::text[]) AS code
     ON CONFLICT (code) DO NOTHING`,
    [PERMISSION_CODES],
  )
  const res = await q.query<{ code: string; id: string }>(
    `SELECT code, id FROM permissions WHERE code = ANY($1::text[])`,
    [PERMISSION_CODES],
  )
  return Object.fromEntries(res.rows.map((r) => [r.code, r.id]))
}

async function seedRolesForTenant(q: Q, tenantId: string, permissionIds: Record<string, string>): Promise<void> {
  for (const [roleName, def] of Object.entries(SYSTEM_ROLES)) {
    await q.exec(
      `INSERT INTO roles (id, tenant_id, name, is_system_role)
       VALUES (gen_random_uuid(), $1, $2, true)
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [tenantId, roleName],
    )
    const role = await q.query<{ id: string }>(`SELECT id FROM roles WHERE tenant_id = $1 AND name = $2`, [
      tenantId,
      roleName,
    ])
    const roleId = role.rows[0]!.id
    // Reconcile the system role's permission set instead of "insert if absent":
    // a re-seed must reflect permission changes shipped in later releases.
    await q.exec(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId])
    for (const permCode of def.permissions) {
      const permissionId = permissionIds[permCode]
      if (!permissionId) continue
      await q.exec(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [roleId, permissionId],
      )
    }
  }
}

async function seedUsersAndRoles(q: Q, users: SeedUser[], tenantId: string): Promise<void> {
  for (const user of users) {
    const passwordHash = await scryptHash(user.password)
    await q.exec(
      `INSERT INTO user_accounts (id, tenant_id, email, password_hash, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (tenant_id, email) DO NOTHING`,
      [user.id, tenantId, user.email, passwordHash],
    )
    for (const role of user.roles) {
      const roleRow = await q.query<{ id: string }>(`SELECT id FROM roles WHERE tenant_id = $1 AND name = $2`, [
        tenantId,
        role,
      ])
      if (!roleRow.rows[0]) continue
      await q.exec(
        `INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [user.id, roleRow.rows[0].id, tenantId],
      )
    }
  }
}

async function seedAcme(q: Q): Promise<void> {
  await q.exec(
    `INSERT INTO tenants (id, name, subdomain, plan, status)
     VALUES ($1, 'Acme Corp', 'acme', 'grow', 'active') ON CONFLICT (id) DO NOTHING`,
    [SEED.TENANT_ACME],
  )
  await q.exec(
    `INSERT INTO departments (id, tenant_id, name, cost_center)
     VALUES
       ($1, $2, 'Design', 'CC-100'),
       ($3, $2, 'Engineering', 'CC-200'),
       ($4, $2, 'Finance', 'CC-300')
     ON CONFLICT (id) DO NOTHING`,
    [SEED.DEPT_DESIGN, SEED.TENANT_ACME, SEED.DEPT_ENG, SEED.DEPT_FIN],
  )
  await q.exec(
    `INSERT INTO locations (id, tenant_id, name, country, timezone)
     VALUES ($1, $2, 'Lahore', 'PK', 'Asia/Karachi'), ($3, $2, 'London', 'GB', 'Europe/London')
     ON CONFLICT (id) DO NOTHING`,
    [SEED.LOC_LHR, SEED.TENANT_ACME, SEED.LOC_LDN],
  )

  const permissionIds = await seedPermissions(q)
  await seedRolesForTenant(q, SEED.TENANT_ACME, permissionIds)
  await seedUsersAndRoles(q, ACME_USERS, SEED.TENANT_ACME)

  const employees: Array<[string, string, string, string | null, string, string | null]> = [
    // id, number, name, manager, jobTitle, user account
    [SEED.EMP_ADMIN, 'EMP-0001', 'Samir Khalid', null, 'Managing Director', SEED.USER_ADMIN],
    [SEED.EMP_PRIYA, 'EMP-0002', 'Priya Menon', SEED.EMP_ADMIN, 'Design Lead', SEED.USER_PRIYA],
    [SEED.EMP_AISHA, 'EMP-0003', 'Aisha Khan', SEED.EMP_PRIYA, 'Senior Product Designer', SEED.USER_AISHA],
  ]
  for (const [id, number, name, manager, jobTitle, userAccountId] of employees) {
    const [firstName, lastName] = name.split(' ')
    const hireDate = `${2023 - Number(number.slice(-1)) + 1}-01-${String(10 + Number(number.slice(-1)))}`
    await q.exec(
      `INSERT INTO employees
         (id, tenant_id, user_account_id, employee_number, first_name, last_name, work_email,
          department_id, location_id, manager_employee_id, job_title, employment_type,
          employment_status, hire_date, custom_fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'full_time', 'active', $12, '{}'::jsonb)
       ON CONFLICT (tenant_id, employee_number) DO NOTHING`,
      [
        id,
        SEED.TENANT_ACME,
        userAccountId,
        number,
        firstName,
        lastName,
        `${firstName!.toLowerCase()}.${lastName!.toLowerCase()}@acme.com`,
        SEED.DEPT_DESIGN,
        SEED.LOC_LHR,
        manager,
        jobTitle,
        hireDate,
      ],
    )
    await q.exec(
      `INSERT INTO employment_history
         (id, tenant_id, employee_id, effective_date, job_title, department_id, employment_status, change_reason)
       SELECT gen_random_uuid(), $1, $2, $3, $4, $5, 'active', 'hire'
       WHERE NOT EXISTS (
         SELECT 1 FROM employment_history eh WHERE eh.employee_id = $2 AND eh.change_reason = 'hire'
       )`,
      [SEED.TENANT_ACME, id, hireDate, jobTitle, SEED.DEPT_DESIGN],
    )
  }

  await q.exec(
    `INSERT INTO leave_types (id, tenant_id, name, accrual_days_per_year, carry_forward_max_days, requires_approval)
     VALUES
       ($1, $2, 'Annual Leave', 24, 10, true),
       ($3, $2, 'Sick Leave', 12, 0, true),
       ($4, $2, 'Personal Leave', 5, 3, true)
     ON CONFLICT (tenant_id, name) DO NOTHING`,
    [SEED.LEAVE_ANNUAL, SEED.TENANT_ACME, SEED.LEAVE_SICK, SEED.LEAVE_PERSONAL],
  )

  // Aisha: 24 accrued − 9.5 used = 14.5 remaining (matches the design concept).
  await q.exec(
    `INSERT INTO leave_balances (id, tenant_id, employee_id, leave_type_id, year, accrued_days, used_days, carried_over_days)
     VALUES (gen_random_uuid(), $1, $2, $3, 2026, 24, 9.5, 0),
            (gen_random_uuid(), $1, $2, $4, 2026, 12, 0, 0),
            (gen_random_uuid(), $1, $2, $5, 2026, 5, 0, 0),
            (gen_random_uuid(), $1, $6, $3, 2026, 24, 5, 0)
     ON CONFLICT DO NOTHING`,
    [
      SEED.TENANT_ACME,
      SEED.EMP_AISHA,
      SEED.LEAVE_ANNUAL,
      SEED.LEAVE_SICK,
      SEED.LEAVE_PERSONAL,
      SEED.EMP_PRIYA,
    ],
  )

  // A hand-written employee to exercise the API later (matches the mockup's Marcus Webb).
  await q.exec(
    `INSERT INTO employees
       (id, tenant_id, employee_number, first_name, last_name, work_email,
        department_id, location_id, manager_employee_id, job_title, employment_type,
        employment_status, hire_date)
      VALUES ($1, $2, 'EMP-0009', 'Marcus', 'Webb', 'marcus.webb@acme.com',
              $3, $4, $5, 'Finance Analyst', 'full_time', 'active', '2023-06-01')
      -- Idempotent against the natural (tenant_id, employee_number) key, same as the
      -- Acme trio above: a pre-existing Marcus row (seeded by older seed versions
      -- under a random id) must not cause a duplicate-key violation on re-seed.
      ON CONFLICT (tenant_id, employee_number) DO NOTHING`,
    [
      SEED.EMP_MARCUS,
      SEED.TENANT_ACME,
      SEED.DEPT_FIN,
      SEED.LOC_LDN,
      SEED.EMP_ADMIN,
    ],
  )
}

async function seedGlobex(q: Q): Promise<void> {
  await q.exec(
    `INSERT INTO tenants (id, name, subdomain, plan, status)
     VALUES ($1, 'Globex Industries', 'globex', 'core', 'active') ON CONFLICT (id) DO NOTHING`,
    [SEED.TENANT_GLOBEX],
  )
  const permissionIds = await seedPermissions(q)
  await seedRolesForTenant(q, SEED.TENANT_GLOBEX, permissionIds)
  await seedUsersAndRoles(q, GLOBEX_USERS, SEED.TENANT_GLOBEX)

  await q.exec(
    `INSERT INTO employees
       (id, tenant_id, user_account_id, employee_number, first_name, last_name, work_email,
        job_title, employment_type, employment_status, hire_date)
     VALUES ($1, $2, $3, 'EMP-0001', 'Dominique', 'Chen', 'dominique@globex.com',
             'Ops Director', 'full_time', 'active', '2022-02-14')
     ON CONFLICT (tenant_id, employee_number) DO NOTHING`,
    [SEED.EMP_GLOBEX, SEED.TENANT_GLOBEX, SEED.USER_GLOBEX],
  )
  await q.exec(
    `INSERT INTO leave_types (id, tenant_id, name, accrual_days_per_year, carry_forward_max_days, requires_approval)
     VALUES ($1, $2, 'Annual Leave', 20, 5, true)
     ON CONFLICT (tenant_id, name) DO NOTHING`,
    [SEED.LEAVE_ANNUAL_GLOBEX, SEED.TENANT_GLOBEX],
  )
  await q.exec(
    `INSERT INTO leave_balances (id, tenant_id, employee_id, leave_type_id, year, accrued_days, used_days, carried_over_days)
     VALUES (gen_random_uuid(), $1, $2, $3, 2026, 20, 0, 0)
     ON CONFLICT DO NOTHING`,
    [SEED.TENANT_GLOBEX, SEED.EMP_GLOBEX, SEED.LEAVE_ANNUAL_GLOBEX],
  )
}

async function seedAll(db: Db): Promise<void> {
  await db.system(async (q) => {
    await seedAcme(q)
    await seedGlobex(q)
  })
}

/**
 * Idempotent demo seeding. Runs as the superuser so RLS does not constrain
 * cross-tenant setup; all tenant_id values are explicit.
 */
export async function seedDatabase(db: Db): Promise<void> {
  await db.system(async (q) => {
    // Fast path: neon-pooler round trips are slow; skip once fully seeded.
    const existing = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM employees WHERE tenant_id = ANY($1::uuid[])`,
      [[SEED.TENANT_ACME, SEED.TENANT_GLOBEX]],
    )
    // 3 acme + marcus + 1 globex = 5 seeded employees.
    if ((existing.rows[0]?.n ?? 0) >= 5) return
    await seedAcme(q)
    await seedGlobex(q)
  })
}

/**
 * Restores the demo leave state (requests + balances) to its freshly-seeded
 * baseline and re-applies the rest of the seed. The e2e suite mutates leave
 * data (submit/approve), so re-running it must start from clean numbers —
 * otherwise assertions drift. Safe to call on every boot: all other inserts
 * are idempotent.
 */
export async function resetDemoLeaveState(db: Db): Promise<void> {
  await db.system(async (q) => {
    // Leave data (requests + balances) is the one thing the e2e suite mutates
    // (submit/approve). Re-running the suite must start from clean numbers,
    // so wipe the demo tenants' leave state and re-seed it back to baseline.
    // Idempotency-visible mutations (submit/approve) also write their request
    // to idempotency_keys. If a prior run already stored a key+response for
    // these demo tenants, a fixed-key replay would return the cached body
    // WITHOUT inserting a row — leaving every subsequent list empty. Wipe the
    // demo keys here so each run starts idempotency-clean.
    await q.exec(`DELETE FROM idempotency_keys WHERE tenant_id = ANY($1::uuid[])`, [
      [SEED.TENANT_ACME, SEED.TENANT_GLOBEX],
    ])
    await q.exec(`DELETE FROM leave_requests WHERE tenant_id = ANY($1::uuid[])`, [
      [SEED.TENANT_ACME, SEED.TENANT_GLOBEX],
    ])
    await q.exec(`DELETE FROM leave_balances WHERE tenant_id = ANY($1::uuid[])`, [
      [SEED.TENANT_ACME, SEED.TENANT_GLOBEX],
    ])
    // Attendance records are created/destroyed by the same suite's clock-in/out
    // flow; wipe them so re-runs start from a clean state.
    await q.exec(`DELETE FROM attendance_records WHERE tenant_id = ANY($1::uuid[])`, [
      [SEED.TENANT_ACME, SEED.TENANT_GLOBEX],
    ])
    await seedAcme(q)
    await seedGlobex(q)
  })
}

/** Alias kept for call sites that want the full idempotent seed. */
export { seedDatabase as seedEverything }

export const DEV_CREDENTIALS = [
  { subdomain: 'acme', email: 'admin@acme.com', password: 'admin123', role: 'admin' },
  { subdomain: 'acme', email: 'priya@acme.com', password: 'manager123', role: 'manager' },
  { subdomain: 'acme', email: 'aisha@acme.com', password: 'employee123', role: 'employee' },
  { subdomain: 'globex', email: 'admin@globex.com', password: 'admin123', role: 'admin' },
].map((c) => ({
  ...c,
  signin: `POST /auth/login {"email":"${c.email}","password":"${c.password}","tenantSubdomain":"${c.subdomain}"}`,
}))