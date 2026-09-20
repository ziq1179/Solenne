import type { Q } from '../../db/index.js'

export interface TenantRow {
  id: string
  name: string
  subdomain: string
  plan: string
  status: string
}

export interface ProvisionedLeaveType {
  id: string
  name: string
}

/** Creates a new tenant. May throw a pg unique-violation (23505) on duplicated subdomain. */
export async function insertTenant(q: Q, input: { id: string; name: string; subdomain: string }): Promise<TenantRow> {
  await q.exec(
    `INSERT INTO tenants (id, name, subdomain, plan, status)
     VALUES ($1, $2, $3, 'trial', 'active')`,
    [input.id, input.name, input.subdomain],
  )
  const res = await q.query<TenantRow>(
    `SELECT id, name, subdomain, plan, status FROM tenants WHERE id = $1`,
    [input.id],
  )
  return res.rows[0]!
}

export async function insertUser(
  q: Q,
  input: { id: string; tenantId: string; email: string; passwordHash: string },
): Promise<void> {
  await q.exec(
    `INSERT INTO user_accounts (id, tenant_id, email, password_hash, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [input.id, input.tenantId, input.email, input.passwordHash],
  )
}

export async function findRoleIdByName(q: Q, tenantId: string, name: string): Promise<string | null> {
  const res = await q.query<{ id: string }>(`SELECT id FROM roles WHERE tenant_id = $1 AND name = $2`, [
    tenantId,
    name,
  ])
  return res.rows[0]?.id ?? null
}

export async function assignUserRole(q: Q, userId: string, roleId: string, tenantId: string): Promise<void> {
  await q.exec(
    `INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [userId, roleId, tenantId],
  )
}

/** The signup creates one employee row for the admin user (linked via user_account_id). */
export async function insertAdminEmployee(
  q: Q,
  input: {
    id: string
    tenantId: string
    userId: string
    firstName: string
    lastName: string
    workEmail: string
    hireDate: string
  },
): Promise<void> {
  await q.exec(
    `INSERT INTO employees
       (id, tenant_id, user_account_id, employee_number, first_name, last_name, work_email,
        job_title, employment_type, employment_status, hire_date)
     VALUES ($1, $2, $3, 'EMP-0001', $4, $5, $6, 'Administrator', 'full_time', 'active', $7)`,
    [input.id, input.tenantId, input.userId, input.firstName, input.lastName, input.workEmail, input.hireDate],
  )
}

export async function insertEmploymentHistory(
  q: Q,
  input: {
    id: string
    tenantId: string
    employeeId: string
    effectiveDate: string
  },
): Promise<void> {
  await q.exec(
    `INSERT INTO employment_history
       (id, tenant_id, employee_id, effective_date, job_title, department_id,
        manager_employee_id, employment_status, change_reason)
     VALUES ($1, $2, $3, $4, 'Administrator', NULL, NULL, 'active', 'hire')`,
    [input.id, input.tenantId, input.employeeId, input.effectiveDate],
  )
}

/** Standard leave catalog every new tenant starts with. Returns all rows for the tenant. */
export async function insertStandardLeaveTypes(q: Q, tenantId: string): Promise<ProvisionedLeaveType[]> {
  await q.exec(
    `INSERT INTO leave_types (id, tenant_id, name, accrual_days_per_year, carry_forward_max_days, requires_approval)
     VALUES (gen_random_uuid(), $1, 'Annual Leave', 24, 10, true),
            (gen_random_uuid(), $1, 'Sick Leave', 12, 0, true),
            (gen_random_uuid(), $1, 'Personal Leave', 5, 3, true)
     ON CONFLICT (tenant_id, name) DO NOTHING`,
    [tenantId],
  )
  const res = await q.query<ProvisionedLeaveType>(
    `SELECT id, name FROM leave_types WHERE tenant_id = $1 ORDER BY name`,
    [tenantId],
  )
  return res.rows
}

export async function insertLeaveBalance(
  q: Q,
  input: { tenantId: string; employeeId: string; leaveTypeId: string; year: number },
): Promise<void> {
  await q.exec(
    `INSERT INTO leave_balances (id, tenant_id, employee_id, leave_type_id, year, accrued_days, used_days, carried_over_days)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, 0, 0)
     ON CONFLICT (tenant_id, employee_id, leave_type_id, year) DO NOTHING`,
    [input.tenantId, input.employeeId, input.leaveTypeId, input.year],
  )
}