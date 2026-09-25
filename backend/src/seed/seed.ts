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

  // Phase 4 — Performance Management seed data (Acme).
  PERF_CYCLE_Q3: '4d000000-0000-4000-8000-000000000001',
  PERF_CYCLE_DRAFT: '4d000000-0000-4000-8000-000000000002',
  PERF_GOAL_AISHA_1: '5e000000-0000-4000-8000-000000000001',
  PERF_GOAL_AISHA_2: '5e000000-0000-4000-8000-000000000002',
  PERF_GOAL_PRIYA_1: '5e000000-0000-4000-8000-000000000003',
  PERF_GOAL_MARCUS_1: '5e000000-0000-4000-8000-000000000004',
  PERF_REVIEW_AISHA: '6f000000-0000-4000-8000-000000000001',
  PERF_REVIEW_PRIYA: '6f000000-0000-4000-8000-000000000002',
  PERF_FEEDBACK_1: '7a000000-0000-4000-8000-000000000001',
  PERF_FEEDBACK_2: '7a000000-0000-4000-8000-000000000002',

  // Phase 4 — Benefits Administration seed data (Acme).
  BEN_PLAN_MEDICAL: '8b000000-0000-4000-8000-000000000001',
  BEN_PLAN_DENTAL: '8b000000-0000-4000-8000-000000000002',
  BEN_PERIOD_OPEN: '9c000000-0000-4000-8000-000000000001',
  BEN_PERIOD_CLOSED: '9c000000-0000-4000-8000-000000000002',
  BEN_ENROLLMENT_AISHA: 'ad000000-0000-4000-8000-000000000001',
  BEN_DEPENDENT_AISHA_SPOUSE: 'be000000-0000-4000-8000-000000000001',
  BEN_LIFE_EVENT_AISHA: 'cf000000-0000-4000-8000-000000000001',

  // Phase 4 — Integration Hub seed data (Acme).
  INT_SLACK_WEBHOOK: 'da000000-0000-4000-8000-000000000001',
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

  // Compensation record for the globex employee (needed for payroll seeding)
  await q.exec(
    `INSERT INTO compensation_records (id, tenant_id, employee_id, effective_date, base_salary_amount, currency, pay_frequency, change_reason)
     VALUES (gen_random_uuid(), $1, $2, '2022-02-14', 86400.00, 'USD', 'monthly', 'hire')
     ON CONFLICT DO NOTHING`,
    [SEED.TENANT_GLOBEX, SEED.EMP_GLOBEX],
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

async function seedPayroll(q: Q): Promise<void> {
  // Seed a paid payroll run for globex (July 2026) with a payslip for the globex employee
  await q.exec(
    `INSERT INTO payroll_runs (id, tenant_id, period_start, period_end, status, total_gross, total_net, total_deductions, employee_count, currency, paid_at, created_by)
     VALUES ($1, $2, '2026-07-01', '2026-07-31', 'paid', 7200.00, 5139.40, 2060.60, 1, 'USD', '2026-08-05 00:00:00+00', (SELECT id FROM user_accounts WHERE tenant_id = $2 LIMIT 1))
     ON CONFLICT (tenant_id, period_start, period_end) DO NOTHING`,
    ['a0000000-0000-4000-8000-000000000001', SEED.TENANT_GLOBEX],
  )
  await q.exec(
    `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, compensation_record_id, base_pay, gross_pay, deductions, total_deductions, net_pay, currency, tax_compliant)
     SELECT gen_random_uuid(), $2, $1, cr.employee_id, cr.id, 7200.00, 7200.00,
            '[{"name":"Federal income tax","amount":1080.00},{"name":"FICA","amount":554.40},{"name":"State tax","amount":426.20}]'::jsonb,
            2060.60, 5139.40, 'USD', false
     FROM compensation_records cr
     WHERE cr.tenant_id = $2 AND cr.employee_id = $3
     ON CONFLICT DO NOTHING`,
    ['a0000000-0000-4000-8000-000000000001', SEED.TENANT_GLOBEX, SEED.EMP_GLOBEX],
  )
  // Seed a draft run for August 2026 (current month, not yet calculated)
  await q.exec(
    `INSERT INTO payroll_runs (id, tenant_id, period_start, period_end, status, currency, created_by)
     VALUES ($1, $2, '2026-08-01', '2026-08-31', 'draft', 'USD', (SELECT id FROM user_accounts WHERE tenant_id = $2 LIMIT 1))
     ON CONFLICT (tenant_id, period_start, period_end) DO NOTHING`,
    ['a0000000-0000-4000-8000-000000000002', SEED.TENANT_GLOBEX],
  )
}

async function seedPerformance(q: Q): Promise<void> {
  // Ensure the unique constraint exists (may not be present on older databases)
  await q.exec(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_cycle_name') THEN
      ALTER TABLE review_cycles ADD CONSTRAINT unique_cycle_name UNIQUE (tenant_id, name);
    END IF;
  END $$`)

  // Review cycles — one active (collecting), one draft
  await q.exec(
    `INSERT INTO review_cycles (id, tenant_id, name, status, starts_at, ends_at, review_deadline, created_by)
     VALUES
       ($1, $2, 'Q3 2026', 'collecting', '2026-07-01', '2026-09-30', '2026-10-15',
        (SELECT id FROM user_accounts WHERE tenant_id = $2 LIMIT 1)),
       ($3, $2, 'Q4 2026', 'draft', '2026-10-01', '2026-12-31', NULL,
        (SELECT id FROM user_accounts WHERE tenant_id = $2 LIMIT 1))
     ON CONFLICT (tenant_id, name) DO NOTHING`,
    [SEED.PERF_CYCLE_Q3, SEED.TENANT_ACME, SEED.PERF_CYCLE_DRAFT],
  )

  // Goals — Aisha has 2, Priya has 1, Marcus has 1
  await q.exec(
    `INSERT INTO goals (id, tenant_id, employee_id, title, description, category, goal_type, percentage, status, due_date, created_by)
     VALUES
       ($1, $2, $3, 'Ship onboarding redesign', 'Complete the new onboarding flow', 'design', 'okr', 90, 'active', '2026-09-30', $4),
       ($5, $2, $3, 'Mentor two junior designers', 'Provide weekly 1:1s and portfolio reviews', 'growth', 'okr', 60, 'active', NULL, $4),
       ($6, $2, $7, 'Launch design system v2', 'Publish updated component library', 'design', 'okr', 75, 'active', '2026-09-30', $8),
       ($9, $2, $10, 'Reduce support handoff time', 'Streamline cross-team processes', 'cross-team', 'kpi', 45, 'active', '2026-10-15', $11)
     ON CONFLICT (id) DO NOTHING`,
    [
      SEED.PERF_GOAL_AISHA_1, SEED.TENANT_ACME, SEED.EMP_AISHA, SEED.USER_AISHA,
      SEED.PERF_GOAL_AISHA_2,
      SEED.PERF_GOAL_PRIYA_1, SEED.EMP_PRIYA, SEED.USER_PRIYA,
      SEED.PERF_GOAL_MARCUS_1, SEED.EMP_MARCUS, SEED.USER_ADMIN,
    ],
  )

  // Map Aisha's goals to Q3 cycle
  await q.exec(
    `INSERT INTO cycle_goals (id, tenant_id, cycle_id, goal_id)
     VALUES
       (gen_random_uuid(), $1, $2, $3),
       (gen_random_uuid(), $1, $2, $4)
     ON CONFLICT (cycle_id, goal_id) DO NOTHING`,
    [SEED.TENANT_ACME, SEED.PERF_CYCLE_Q3, SEED.PERF_GOAL_AISHA_1, SEED.PERF_GOAL_AISHA_2],
  )

  // Performance reviews — Aisha has one with self+manager review (not finalized)
  // Priya has one (draft only)
  await q.exec(
    `INSERT INTO performance_reviews
       (id, tenant_id, cycle_id, employee_id,
        self_rating, self_comment, self_submitted_at,
        manager_id, manager_rating, manager_comment, manager_submitted_at,
        status)
     VALUES
       ($1, $2, $3, $4,
        4, 'Strong quarter, shipped on time', now() - interval '2 days',
        $5, 5, 'Exceptional work on the redesign', now() - interval '1 day',
        'manager_reviewing'),
       ($6, $2, $3, $5,
        NULL, NULL, NULL,
        NULL, NULL, NULL, NULL,
        'draft')
     ON CONFLICT (cycle_id, employee_id) DO NOTHING`,
    [SEED.PERF_REVIEW_AISHA, SEED.TENANT_ACME, SEED.PERF_CYCLE_Q3, SEED.EMP_AISHA, SEED.EMP_PRIYA, SEED.PERF_REVIEW_PRIYA],
  )

  // Feedback — Priya → Aisha (coaching), Marcus → Aisha (kudos)
  await q.exec(
    `INSERT INTO feedback_entries (id, tenant_id, author_id, recipient_id, content, feedback_type)
     VALUES
       ($1, $2, $3, $4, 'Great job leading the redesign sprint', 'coaching'),
       ($5, $2, $6, $4, 'Thanks for the design system review', 'kudos')
     ON CONFLICT (id) DO NOTHING`,
    [SEED.PERF_FEEDBACK_1, SEED.TENANT_ACME, SEED.EMP_PRIYA, SEED.EMP_AISHA, SEED.PERF_FEEDBACK_2, SEED.EMP_MARCUS],
  )
}

async function seedBenefits(q: Q): Promise<void> {
  // Benefit plans — medical (with tiers) and dental
  await q.exec(
    `INSERT INTO benefit_plans
       (id, tenant_id, name, description, plan_type, carrier_name,
        coverage_tiers, employer_contribution_pct, employee_cost, created_by)
     VALUES
       ($1, $2, 'Blue Cross PPO', 'Comprehensive medical coverage', 'medical', 'Blue Cross',
        '{"employee_only","employee_spouse","employee_child","family"}', 70.00,
        '{"employee_only": 250.00, "employee_spouse": 500.00, "employee_child": 400.00, "family": 800.00}'::jsonb,
        (SELECT id FROM user_accounts WHERE tenant_id = $2 LIMIT 1)),
       ($3, $2, 'Delta Dental', 'Standard dental coverage', 'dental', 'Delta Dental',
        '{"employee_only","employee_spouse","employee_child","family"}', 50.00,
        '{"employee_only": 30.00, "employee_spouse": 60.00, "employee_child": 50.00, "family": 100.00}'::jsonb,
        (SELECT id FROM user_accounts WHERE tenant_id = $2 LIMIT 1))
     ON CONFLICT (id) DO NOTHING`,
    [SEED.BEN_PLAN_MEDICAL, SEED.TENANT_ACME, SEED.BEN_PLAN_DENTAL],
  )

  // Enrollment periods — one active, one closed
  await q.exec(
    `INSERT INTO enrollment_periods
       (id, tenant_id, name, description, period_type, status, starts_at, ends_at, coverage_starts, created_by)
     VALUES
       ($1, $2, 'Q4 2026 Open Enrollment', 'Annual open enrollment for 2027 coverage', 'open_enrollment', 'active',
        '2026-10-01T00:00:00Z', '2026-10-31T23:59:59Z', '2027-01-01',
        (SELECT id FROM user_accounts WHERE tenant_id = $2 LIMIT 1)),
       ($3, $2, 'Q3 2026 Open Enrollment', 'Past enrollment period', 'open_enrollment', 'closed',
        '2026-07-01T00:00:00Z', '2026-07-31T23:59:59Z', '2026-10-01',
        (SELECT id FROM user_accounts WHERE tenant_id = $2 LIMIT 1))
     ON CONFLICT (id) DO NOTHING`,
    [SEED.BEN_PERIOD_OPEN, SEED.TENANT_ACME, SEED.BEN_PERIOD_CLOSED],
  )

  // Dependent for Aisha (spouse)
  await q.exec(
    `INSERT INTO benefit_dependents
       (id, tenant_id, employee_id, first_name, last_name, relationship, date_of_birth, is_active)
     VALUES ($1, $2, $3, 'Omar', 'Khan', 'spouse', '1992-05-15', true)
     ON CONFLICT (id) DO NOTHING`,
    [SEED.BEN_DEPENDENT_AISHA_SPOUSE, SEED.TENANT_ACME, SEED.EMP_AISHA],
  )

  // Enrollment for Aisha in the open period (submitted)
  await q.exec(
    `INSERT INTO benefit_enrollments
       (id, tenant_id, employee_id, enrollment_period_id, benefit_plan_id,
        coverage_tier, employee_premium, employer_premium, status, submitted_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'employee_spouse', 500.00, 500.00, 'submitted', now(),
        (SELECT id FROM user_accounts WHERE tenant_id = $2 LIMIT 1))
     ON CONFLICT (employee_id, enrollment_period_id, benefit_plan_id) DO NOTHING`,
    [SEED.BEN_ENROLLMENT_AISHA, SEED.TENANT_ACME, SEED.EMP_AISHA, SEED.BEN_PERIOD_OPEN, SEED.BEN_PLAN_MEDICAL],
  )

  // Link Aisha's spouse to the enrollment
  await q.exec(
    `INSERT INTO enrollment_dependents (id, tenant_id, enrollment_id, dependent_id)
     VALUES (gen_random_uuid(), $1, $2, $3)
     ON CONFLICT (enrollment_id, dependent_id) DO NOTHING`,
    [SEED.TENANT_ACME, SEED.BEN_ENROLLMENT_AISHA, SEED.BEN_DEPENDENT_AISHA_SPOUSE],
  )

  // Life event for Aisha (reported, not yet acknowledged)
  await q.exec(
    `INSERT INTO life_events
       (id, tenant_id, employee_id, event_type, event_date, description, status)
     VALUES ($1, $2, $3, 'marriage', '2026-09-01', 'Recently married', 'reported')
     ON CONFLICT (id) DO NOTHING`,
     [SEED.BEN_LIFE_EVENT_AISHA, SEED.TENANT_ACME, SEED.EMP_AISHA],
  )
}

async function seedIntegrationHub(q: Q): Promise<void> {
  // Slack webhook connection — uses a placeholder webhook URL for demo.
  // In production this would be a real Slack incoming webhook URL.
  const maskedPreview = 'https://hooks.slack.com/services/T00000/B00000/****'
  const placeholderEnc = '00'.repeat(12) + ':' + '00'.repeat(32) + ':' + '00'.repeat(16) + ':' + '00'.repeat(12) + ':' + '00'.repeat(32) + ':' + '00'.repeat(16)

  await q.exec(
    `INSERT INTO integration_connections
       (id, tenant_id, provider, label, credential_enc, masked_preview, key_version, status, config_json, created_by)
     VALUES ($1, $2, 'slack_webhook', 'Acme #general notifications', $3, $4, 1, 'disconnected',
       '{"channel": "#general"}'::jsonb,
       (SELECT id FROM user_accounts WHERE tenant_id = $2 LIMIT 1))
     ON CONFLICT (id) DO NOTHING`,
    [SEED.INT_SLACK_WEBHOOK, SEED.TENANT_ACME, placeholderEnc, maskedPreview],
  )
}

async function seedAll(db: Db): Promise<void> {
  await db.system(async (q) => {
    await seedAcme(q)
    await seedGlobex(q)
    await seedAts(q)
    await seedOnboarding(q)
    await seedBilling(q)
    await seedPayroll(q)
    await seedPerformance(q)
    await seedBenefits(q)
    await seedIntegrationHub(q)
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
    await seedPayroll(q)
    await seedPerformance(q)
    await seedBenefits(q)
    await seedIntegrationHub(q)
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
       DELETE FROM onboarding_template_tasks WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM onboarding_templates WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM job_openings         WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM employment_history   WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM payslips             WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM payroll_runs         WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM compensation_records WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM enrollment_dependents WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM benefit_enrollments  WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM life_events          WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM benefit_dependents   WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM enrollment_periods   WHERE tenant_id = ANY(${DEMO_TENANTS});
        DELETE FROM benefit_plans        WHERE tenant_id = ANY(${DEMO_TENANTS});
        DELETE FROM integration_connections WHERE tenant_id = ANY(${DEMO_TENANTS});
        DELETE FROM feedback_entries     WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM performance_reviews  WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM cycle_goals          WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM goals                WHERE tenant_id = ANY(${DEMO_TENANTS});
       DELETE FROM review_cycles        WHERE tenant_id = ANY(${DEMO_TENANTS});
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
    await seedPayroll(q)
    await seedPerformance(q)
    await seedBenefits(q)
    await seedIntegrationHub(q)
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