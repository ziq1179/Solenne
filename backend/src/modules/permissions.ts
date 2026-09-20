/** Canonical permission codes (seeded per tenant). */
export const PERMISSIONS = {
  EMPLOYEE_READ: 'employee:read',
  EMPLOYEE_WRITE: 'employee:write',
  LEAVE_READ: 'leave:read',
  LEAVE_APPROVE: 'leave:approve',
  ATTENDANCE_READ: 'attendance:read',
  AUDIT_READ: 'audit:read',
} as const

export const PERMISSION_CODES = Object.values(PERMISSIONS)

/** Built-in roles and the canonical permission set each one holds. */
export const SYSTEM_ROLES: Record<
  'admin' | 'hr_manager' | 'manager' | 'employee',
  { label: string; permissions: string[] }
> = {
  admin: {
    label: 'Administrator',
    permissions: [
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.EMPLOYEE_WRITE,
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.ATTENDANCE_READ,
      PERMISSIONS.AUDIT_READ,
    ],
  },
  hr_manager: {
    label: 'HR Manager',
    permissions: [
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.EMPLOYEE_WRITE,
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.ATTENDANCE_READ,
      PERMISSIONS.AUDIT_READ,
    ],
  },
  manager: {
    label: 'Manager',
    permissions: [
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.ATTENDANCE_READ,
    ],
  },
  employee: {
    label: 'Employee',
    permissions: [
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.ATTENDANCE_READ,
    ],
  },
}