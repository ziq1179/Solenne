/** Canonical permission codes (seeded per tenant). */
export const PERMISSIONS = {
  EMPLOYEE_READ: 'employee:read',
  EMPLOYEE_WRITE: 'employee:write',
  LEAVE_READ: 'leave:read',
  LEAVE_APPROVE: 'leave:approve',
  ATTENDANCE_READ: 'attendance:read',
  AUDIT_READ: 'audit:read',
  REPORTING_READ: 'reporting:read',
  ATS_READ: 'ats:read',
  ATS_WRITE: 'ats:write',
  ATS_APPROVE: 'ats:approve',
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
      PERMISSIONS.REPORTING_READ,
      PERMISSIONS.ATS_READ,
      PERMISSIONS.ATS_WRITE,
      PERMISSIONS.ATS_APPROVE,
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
      PERMISSIONS.REPORTING_READ,
      PERMISSIONS.ATS_READ,
      PERMISSIONS.ATS_WRITE,
      PERMISSIONS.ATS_APPROVE,
    ],
  },
  manager: {
    label: 'Manager',
    permissions: [
      PERMISSIONS.EMPLOYEE_READ,
      PERMISSIONS.LEAVE_READ,
      PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.ATTENDANCE_READ,
      // Managers raise requisitions (write) but approval/posting stays with HR/admin.
      PERMISSIONS.ATS_READ,
      PERMISSIONS.ATS_WRITE,
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