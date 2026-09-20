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

  // Phase 2 — ATS demo data (Acme).
  JOB_DESIGNER: '9b0a0000-0000-4000-8000-000000000001',
  JOB_CSM: '9b0a0000-0000-4000-8000-000000000002',
  CAND_LENA: '9c000000-0000-4000-8000-000000000001',
  CAND_RYO: '9c000000-0000-4000-8000-000000000002',
  CAND_OFFER: '9c000000-0000-4000-8000-000000000003',

  // Phase 2 — Onboarding/Offboarding templates (Acme).
  ONB_TEMPLATE_HIRE: '2b000000-0000-4000-8000-000000000001',
  ONB_TEMPLATE_EXIT: '2b000000-0000-4000-8000-000000000002',

  // Phase 2 — Billing subscriptions (one per demo tenant).
  SUB_ACME: '3c000000-0000-4000-8000-000000000001',
  SUB_GLOBEX: '3c000000-0000-4000-8000-000000000002',
} as const

interface SeedUser {
  id: string
  email: string
  password: string
  roles: (keyof typeof SYSTEM_ROLES)[]
}

/** Demo tenant roster the seed/reset operations are confined to (kept as
 *  literals below: node-postgres forbids bind parameters in multi-statement
 *  query strings, and these ids are compile-time constants). */
const DEMO_TENANTS = `'{${SEED.TENANT_ACME},${SEED.TENANT_GLOBEX}}'::uuid[]`

/** The canonical seed roster that resets KEEP — everything else is purged. */
const KEPT_EMPLOYEES = `'{${SEED.EMP_ADMIN},${SEED.EMP_PRIYA},${SEED.EMP_AISHA},${SEED.EMP_MARCUS},${SEED.EMP_GLOBEX}}'::uuid[]`

const ACME_USERS: SeedUser[] = [
  { id: SEED.USER_ADMIN, email: 'admin@acme.com', password: 'admin123', roles: ['admin', 'employee'] },
  { id: SEED.USER_PRIYA, email: 'priya@acme.com', password: 'manager123', roles: ['manager', 'employee'] },
  { id: SEED.USER_AISHA, email: 'aisha@acme.com', password: 'employee123', roles: ['employee'] },
]

const GLOBEX_USERS: SeedUser[] = [
  { id: SEED.USER_GLOBEX, email: 'admin@globex.com', password: 'admin123', roles: ['admin', 'employee'] },
]

const GMT = 'T00:00:00Z'

/** Global permissions catalog (ON CONFLICT code, idempotent). Exported for
 *  tenant provisioning at signup time. */
export async function seedPermissions(q: Q): Promise<Record<string, string>> {
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

export async function seedRolesForTenant(q: Q, tenantId: string, permissionIds: Record<string, string>): Promise<void> {
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
    // Batch the grant inserts into one round trip via unnest (same lesson as
    // seedPermissions): a for-loop of INSERTs is N pooler round trips.
    const permissionIdsForRole = def.permissions
      .map((permCode) => permissionIds[permCode])
      .filter((permissionId): permissionId is string => Boolean(permissionId))
    if (permissionIdsForRole.length) {
      await q.exec(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, id FROM unnest($2::uuid[]) AS id
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [roleId, permissionIdsForRole],
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

async function seedAts(q: Q): Promise<void> {
  // Jobs + a small candidate pipeline so the ATS surfaces have data out of the box.
  await q.exec(
    `INSERT INTO job_openings
       (id, tenant_id, title, department_id, location_id, employment_type,
        salary_min, salary_max, currency, description, status)
     VALUES
       ($1, $2, 'Senior Product Designer', $3, $4, 'full_time', 60000, 90000, 'USD',
        'Own end-to-end product design across the Trellis platform.', 'open'),
       ($5, $2, 'Customer Success Manager', $6, $7, 'full_time', 45000, 65000, 'USD',
        'Nurture our growing SMB base into long-term customers.', 'open')
     ON CONFLICT (id) DO NOTHING`,
    [
      SEED.JOB_DESIGNER,
      SEED.TENANT_ACME,
      SEED.DEPT_DESIGN,
      SEED.LOC_LHR,
      SEED.JOB_CSM,
      SEED.DEPT_FIN,
      SEED.LOC_LDN,
    ],
  )
  await q.exec(
    `INSERT INTO job_candidates
       (id, tenant_id, job_opening_id, first_name, last_name, email, phone, resume_text,
        source, stage, rating, notes)
     VALUES
       ($1, $2, $3, 'Lena', 'Ortiz', 'lena.ortiz@example.com', '+1 555 0100',
        '5 years designing B2B SaaS platforms; led design systems at two startups.',
        'linkedin', 'applied', 4, 'Strong portfolio; follow-up with a take-home brief.'),
       ($4, $2, $3, 'Ryo', 'Tanaka', 'ryo.tanaka@example.com', '+81 90 5555 0101',
        'Product designer specialising in fintech web apps; fluent in Figma.',
        'job_board', 'screening', 3, 'Screening call done; schedule portfolio review.'),
       ($5, $2, $3, 'Mira', 'Okafor', 'mira.okafor@example.com', '+44 20 5555 0102',
        'Design lead for an HR software suite; previously at a Series C company.',
        'referral', 'offer', 5, 'Offered; awaiting acceptance.')
     ON CONFLICT (id) DO NOTHING`,
    [
      SEED.CAND_LENA,
      SEED.TENANT_ACME,
      SEED.JOB_DESIGNER,
      SEED.CAND_RYO,
      SEED.CAND_OFFER,
    ],
  )
}

async function seedOnboarding(q: Q): Promise<void> {
  // Default onboarding + offboarding checklists for Acme, so the ATS hire flow
  // auto-starts plans out of the box and HR has an exit template to copy.
  await q.exec(
    `INSERT INTO onboarding_templates
       (id, tenant_id, name, kind, description, is_default, is_active)
     VALUES
       ($1, $2, 'New Hire Welcome', 'onboarding',
        'Standard first-week checklist for every new starter.', true, true),
       ($3, $2, 'Offboarding Checklist', 'offboarding',
        'Standard exit checklist: assets, access, interview and settlement.', true, true)
     ON CONFLICT (id) DO NOTHING`,
    [SEED.ONB_TEMPLATE_HIRE, SEED.TENANT_ACME, SEED.ONB_TEMPLATE_EXIT],
  )
  await q.exec(
    `INSERT INTO onboarding_template_tasks
       (id, tenant_id, template_id, name, category, position, optional)
     VALUES
       ($1, $10, $9, 'Provision laptop + accounts', 'it_provisioning', 0, false),
       ($2, $10, $9, 'Complete HR paperwork', 'paperwork', 1, false),
       ($3, $10, $9, 'Compliance training', 'training', 2, false),
       ($4, $10, $9, 'Team introductions', 'training', 3, true),
       ($5, $10, $11, 'Return company assets', 'asset', 0, false),
       ($6, $10, $11, 'Revoke system access', 'access', 1, false),
       ($7, $10, $11, 'Exit interview', 'exit_interview', 2, true),
       ($8, $10, $11, 'Final settlement hand-off', 'settlement', 3, false)
     ON CONFLICT (id) DO NOTHING`,
    [
      '2b000000-0000-4000-8000-000000000003',
      '2b000000-0000-4000-8000-000000000004',
      '2b000000-0000-4000-8000-000000000005',
      '2b000000-0000-4000-8000-000000000006',
      '2b000000-0000-4000-8000-000000000007',
      '2b000000-0000-4000-8000-000000000008',
      '2b000000-0000-4000-8000-000000000009',
      '2b000000-0000-4000-8000-00000000000a',
      SEED.ONB_TEMPLATE_HIRE,
      SEED.TENANT_ACME,
      SEED.ONB_TEMPLATE_EXIT,
    ],
  )
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

async function seedBilling(q: Q): Promise<void> {
  // Acme is on the 'grow' plan (matches the tenant row); Globex on 'core'.
  await q.exec(
    `INSERT INTO subscriptions (id, tenant_id, plan, status, seat_limit)
     VALUES ($1, $2, 'grow', 'active', 100)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [SEED.SUB_ACME, SEED.TENANT_ACME],
  )
  await q.exec(
    `INSERT INTO subscriptions (id, tenant_id, plan, status, seat_limit)
     VALUES ($1, $2, 'core', 'active', 25)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [SEED.SUB_GLOBEX, SEED.TENANT_GLOBEX],
  )
}

async function seedAll(db: Db): Promise<void> {
  await db.system(async (q) => {
    await seedAcme(q)
    await seedGlobex(q)
    await seedAts(q)
    await seedOnboarding(q)
    await seedBilling(q)
  })
}

/**
 * Idempotent demo seeding. Runs as the superuser so RLS does not constrain
 * cross-tenant setup; all tenant_id values are explicit.
 */
export async function seedDatabase(db: Db): Promise<void> {
  await db.system(async (q) => {
    // Phase 2 demo data is seeded before the Phase 0/1 fast path: an already
    // populated database (e.g. production) still picks up the ATS sample jobs
    // and the default onboarding/offboarding checklists + billing rows.
    await seedAts(q)
    await seedOnboarding(q)
    await seedBilling(q)
    // Fast path: neon-pooler round trips are slow; skip once fully seeded.
    const existing = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM employees WHERE tenant_id = ANY($1::uuid[])`,
      [[SEED.TENANT_ACME, SEED.TENANT_GLOBEX]],
    )
    // 3 acme + marcus + 1 globex = 5 seeded employees.
    if ((existing.rows[0]?.n ?? 0) >= 5) return
    await seedAcme(q)
    await seedGlobex(q)
    await seedAts(q)
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
    // Wipe everything the e2e suite mutates across the demo tenants, then
    // re-seed the baseline below. Leave state is the thing the suite mutates
    // most (submit/approve) — re-runs must start from clean balances. The
    // idempotency-visible mutations also store keys+responses; wiping the demo
    // keys stops a fixed-key replay from returning a cached body WITHOUT
    // inserting a row.
    // Issued as ONE multi-statement query: 14 sequential deletes were 14 pooler
    // round trips, the same per-statement cost the permission insert used to
    // pay before it was batched with unnest. Order is FK-safe (children before
    // parents): plan tasks → plans → employees, candidates → openings, and
    // every employee-referencing table before the employee purge. Kept
    // employees are exempted so the seed roster survives.
    await q.exec(
      `DELETE FROM onboarding_tasks     WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM job_candidates       WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM leave_requests       WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM leave_balances       WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM attendance_records   WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM notifications        WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM usage_events         WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM subscriptions        WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM onboarding_plans     WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM job_openings         WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM employment_history   WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM compensation_records WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM employees            WHERE tenant_id = ANY(${DEMO_TENANTS}) AND id <> ALL(${KEPT_EMPLOYEES});
       DELETE FROM idempotency_keys     WHERE tenant_id = ANY(${DEMO_TENANTS});`,
    )
    // The ATS suite moves demo candidates between pipeline stages (screening→
    // interview, offer→hired, applied→rejected); restore the seeded baseline so
    // re-runs start from a clean pipeline.
    await seedAcme(q)
    await seedGlobex(q)
    await seedAts(q)
    await seedOnboarding(q)
    await seedBilling(q)
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