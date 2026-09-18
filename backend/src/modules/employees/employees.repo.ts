import type { Q, Row } from '../../db/index.js'
import { newId } from '../../db/index.js'

export interface Employee {
  id: string
  employeeNumber: string
  firstName: string
  lastName: string
  workEmail: string | null
  departmentId: string | null
  locationId: string | null
  managerEmployeeId: string | null
  jobTitle: string | null
  employmentType: string
  employmentStatus: string
  hireDate: string
  terminationDate: string | null
  customFields: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface EmployeeInput {
  firstName: string
  lastName: string
  employmentType: string
  hireDate: string
  personalEmail?: string
  workEmail?: string
  departmentId?: string | null
  locationId?: string | null
  managerEmployeeId?: string | null
  jobTitle?: string
  customFields?: Record<string, unknown>
}

interface EmployeeRow extends Row {
  id: string
  employeeNumber: string
  firstName: string
  lastName: string
  workEmail: string | null
  personalEmail: string | null
  departmentId: string | null
  locationId: string | null
  managerEmployeeId: string | null
  jobTitle: string | null
  employmentType: string
  employmentStatus: string
  hireDate: string
  terminationDate: string | null
  customFields: string | Record<string, unknown>
  createdAt: string
  updatedAt: string
}

const COLS = `
  e.id, e.employee_number AS "employeeNumber",
  e.first_name AS "firstName", e.last_name AS "lastName",
  e.personal_email AS "personalEmail", e.work_email AS "workEmail",
  e.department_id AS "departmentId", e.location_id AS "locationId",
  e.manager_employee_id AS "managerEmployeeId", e.job_title AS "jobTitle",
  e.employment_type AS "employmentType", e.employment_status AS "employmentStatus",
  e.hire_date::text AS "hireDate", e.termination_date::text AS "terminationDate",
  e.custom_fields::text AS "customFields",
  e.created_at::text AS "createdAt", e.updated_at::text AS "updatedAt"`

export function mapEmployee(r: EmployeeRow): Employee {
  return {
    ...r,
    customFields:
      typeof r.customFields === 'string' ? ((JSON.parse(r.customFields || '{}') as Record<string, unknown>) ?? {}) : r.customFields,
  }
}

export interface EmployeeFilter {
  status?: string
  departmentId?: string
  /** Restrict to a single employee (self-service scoping). */
  employeeId?: string
}

export async function listEmployees(
  q: Q,
  filter: EmployeeFilter,
  page: number,
  pageSize: number,
): Promise<{ data: Employee[]; total: number }> {
  const conds: string[] = []
  const params: unknown[] = []
  const push = (sql: string, value: unknown) => {
    params.push(value)
    conds.push(sql.replace('?', `$${params.length}`))
  }

  if (filter.status) push(`e.employment_status = ?`, filter.status)
  if (filter.departmentId) push(`e.department_id = ?`, filter.departmentId)
  if (filter.employeeId) push(`e.id = ?`, filter.employeeId)
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  const totalRes = await q.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM employees e ${where}`,
    params,
  )
  const total = totalRes.rows[0]?.total ?? 0

  const offset = (page - 1) * pageSize
  const dataRes = await q.query<EmployeeRow>(
    `SELECT ${COLS} FROM employees e ${where}
     ORDER BY e.first_name, e.last_name
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  )
  return { data: dataRes.rows.map(mapEmployee), total }
}

export async function getEmployeeById(q: Q, id: string): Promise<Employee | null> {
  const res = await q.query<EmployeeRow>(`SELECT ${COLS} FROM employees e WHERE e.id = $1`, [id])
  const row = res.rows[0]
  return row ? mapEmployee(row) : null
}

export async function getEmployeeNumberTaken(q: Q, employeeNumber: string): Promise<boolean> {
  const res = await q.query(`SELECT 1 FROM employees WHERE employee_number = $1 LIMIT 1`, [employeeNumber])
  return res.rows.length > 0
}

export async function insertEmployee(
  q: Q,
  input: EmployeeInput & {
    id: string
    tenantId: string
    employeeNumber: string
    createdBy: string | null
  },
): Promise<Employee> {
  await q.exec(
    `INSERT INTO employees
       (id, tenant_id, employee_number, first_name, last_name, personal_email, work_email,
        department_id, location_id, manager_employee_id, job_title, employment_type,
        employment_status, hire_date, custom_fields, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', $13, $14::jsonb, $15)
     ON CONFLICT (tenant_id, employee_number) DO NOTHING`,
    [
      input.id,
      input.tenantId,
      input.employeeNumber,
      input.firstName,
      input.lastName,
      input.personalEmail ?? null,
      input.workEmail ?? null,
      input.departmentId ?? null,
      input.locationId ?? null,
      input.managerEmployeeId ?? null,
      input.jobTitle ?? null,
      input.employmentType,
      input.hireDate,
      JSON.stringify(input.customFields ?? {}),
      input.createdBy,
    ],
  )
  const created = await getEmployeeById(q, input.id)
  if (!created) return Promise.reject(new Error('INSERT_CONFLICT_EMPLOYEE_NUMBER'))
  return created
}

export async function insertEmploymentHistory(
  q: Q,
  input: {
    id: string
    tenantId: string
    employeeId: string
    effectiveDate: string
    jobTitle: string | null
    departmentId: string | null
    managerEmployeeId: string | null
    employmentStatus: string
    changeReason: string
    createdBy: string | null
  },
): Promise<void> {
  await q.exec(
    `INSERT INTO employment_history
       (id, tenant_id, employee_id, effective_date, job_title, department_id,
        manager_employee_id, employment_status, change_reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.id,
      input.tenantId,
      input.employeeId,
      input.effectiveDate,
      input.jobTitle,
      input.departmentId,
      input.managerEmployeeId,
      input.employmentStatus,
      input.changeReason,
      input.createdBy,
    ],
  )
}

/** Maps API camelCase update keys to their snake_case columns. */
const FIELD_COLUMNS: Record<string, string> = {
  workEmail: 'work_email',
  departmentId: 'department_id',
  locationId: 'location_id',
  managerEmployeeId: 'manager_employee_id',
  jobTitle: 'job_title',
  employmentType: 'employment_type',
  customFields: 'custom_fields',
}

export async function updateEmployeeFields(
  q: Q,
  id: string,
  fields: Record<string, unknown>,
): Promise<Employee | null> {
  const entries = Object.entries(fields).filter(([key]) => key in FIELD_COLUMNS)
  if (entries.length === 0) return getEmployeeById(q, id)
  const sets = entries.map(([key], i) => {
    if (key === 'customFields') return `custom_fields = $${i + 1}::jsonb`
    return `"${FIELD_COLUMNS[key]}" = $${i + 1}`
  })
  await q.exec(`UPDATE employees SET ${sets.join(', ')}, updated_at = now() WHERE id = $${entries.length + 1}`, [
    ...entries.map(([key, v]) => (key === 'customFields' ? JSON.stringify(v ?? {}) : v)),
    id,
  ])
  return getEmployeeById(q, id)
}

export async function terminateEmployee(q: Q, id: string): Promise<Employee | null> {
  await q.exec(
    `UPDATE employees
     SET employment_status = 'terminated', termination_date = current_date, updated_at = now()
     WHERE id = $1`,
    [id],
  )
  return getEmployeeById(q, id)
}

export interface Department {
  id: string
  name: string
  parentId: string | null
  costCenter: string | null
}

export async function listDepartments(q: Q): Promise<Department[]> {
  const res = await q.query<Department>(
    `SELECT id, name, parent_id AS "parentId", cost_center AS "costCenter"
     FROM departments
     ORDER BY name`,
  )
  return res.rows
}

export async function insertDepartment(
  q: Q,
  tenantId: string,
  input: { name: string; parentId?: string; costCenter?: string },
): Promise<Department> {
  const id = newId()
  await q.exec(
    `INSERT INTO departments (id, tenant_id, name, parent_id, cost_center)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, tenantId, input.name, input.parentId ?? null, input.costCenter ?? null],
  )
  const inserted = await q.query<Department>(
    `SELECT id, name, parent_id AS "parentId", cost_center AS "costCenter" FROM departments WHERE id = $1`,
    [id],
  )
  return inserted.rows[0]!
}