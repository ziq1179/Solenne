import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { useIdempotency } from '../../lib/idempotency.js'
import { audit } from '../../lib/audit.js'
import { PERMISSIONS } from '../permissions.js'
import * as repo from './employees.repo.js'
import { newId } from '../../db/index.js'

const employeeCreateSchema = z.object({
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'hireDate must be YYYY-MM-DD'),
  employmentType: z.enum(['full_time', 'part_time', 'contractor']),
  personalEmail: z.string().email().optional(),
  workEmail: z.string().email().optional(),
  departmentId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  managerEmployeeId: z.string().uuid().optional(),
  jobTitle: z.string().min(1).max(200).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
})

const employeePatchSchema = z.object({
  workEmail: z.string().email().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  managerEmployeeId: z.string().uuid().nullable().optional(),
  jobTitle: z.string().min(1).max(200).nullable().optional(),
  employmentType: z.enum(['full_time', 'part_time', 'contractor']).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
})

const departmentCreateSchema = z.object({
  name: z.string().min(1).max(160),
  parentId: z.string().uuid().optional(),
  costCenter: z.string().max(80).optional(),
})

const employeeNumber = () => `EMP-${newId().slice(9, 13).toUpperCase()}`

function toResponse(e: repo.Employee) {
  return {
    id: e.id,
    employeeNumber: e.employeeNumber,
    firstName: e.firstName,
    lastName: e.lastName,
    workEmail: e.workEmail,
    departmentId: e.departmentId,
    locationId: e.locationId,
    managerEmployeeId: e.managerEmployeeId,
    jobTitle: e.jobTitle,
    employmentType: e.employmentType,
    employmentStatus: e.employmentStatus,
    hireDate: e.hireDate,
    terminationDate: e.terminationDate,
    customFields: e.customFields,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }
}

export function registerEmployeeRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  fastify.get(
    '/employees',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.EMPLOYEE_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const page = Math.max(1, Number(qs.page ?? 1))
      const pageSize = Math.min(100, Math.max(1, Number(qs.pageSize ?? 25)))
      const status = qs.status
      const departmentId = qs.departmentId

      return db.tenant(req.ctx.tenantId, async (q) => {
        const filter: repo.EmployeeFilter = { status, departmentId }
        if (!req.ctx.isDirectoryRole) {
          // Self-service: an employee only sees their own record.
          filter.employeeId = req.ctx.employeeId ?? '__none__'
        }
        const { data, total } = await repo.listEmployees(q, filter, page, pageSize)
        return { data: data.map(toResponse), page, pageSize, total }
      })
    },
  )

  fastify.post(
    '/employees',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.EMPLOYEE_WRITE)] },
    async (req, reply) => {
      const parsed = employeeCreateSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid employee payload', parsed.error.flatten())
      const body = parsed.data
      const key = req.headers['idempotency-key'] as string | undefined
      const tenantId = req.ctx.tenantId
      const actorId = req.ctx.userId

      const result = await db.tenant(tenantId, async (q) =>
        useIdempotency(q, tenantId, key, req.body, async () => {
          const id = newId()
          const employee = await repo.insertEmployee(q, {
            ...body,
            id,
            tenantId,
            employeeNumber: employeeNumber(),
            createdBy: actorId,
          })
          await repo.insertEmploymentHistory(q, {
            id: newId(),
            tenantId,
            employeeId: id,
            effectiveDate: body.hireDate,
            jobTitle: body.jobTitle ?? null,
            departmentId: body.departmentId ?? null,
            managerEmployeeId: body.managerEmployeeId ?? null,
            employmentStatus: 'active',
            changeReason: 'hire',
            createdBy: actorId,
          })
          await audit(q, {
            tenantId,
            actorType: 'user',
            actorId,
            action: 'employee.hired',
            entityType: 'employee',
            entityId: id,
            after: toResponse(employee),
            ip: req.ip,
          })
          return { status: 201, body: toResponse(employee) }
        }),
      )
      return reply.code(result.status).send(result.body)
    },
  )

  fastify.get(
    '/employees/:employeeId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.EMPLOYEE_READ)] },
    async (req, reply) => {
      const employeeId = (req.params as { employeeId: string }).employeeId
      return db.tenant(req.ctx.tenantId, async (q) => {
        const employee = await repo.getEmployeeById(q, employeeId)
        if (!employee) throw httpError.notFound('Employee not found')
        if (!req.ctx.isDirectoryRole && employee.id !== req.ctx.employeeId) {
          throw httpError.notFound('Employee not found')
        }
        return reply.send(toResponse(employee))
      })
    },
  )

  fastify.patch(
    '/employees/:employeeId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.EMPLOYEE_WRITE)] },
    async (req, reply) => {
      const parsed = employeePatchSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid employee payload', parsed.error.flatten())
      const employeeId = (req.params as { employeeId: string }).employeeId
      const tenantId = req.ctx.tenantId
      const actorId = req.ctx.userId
      const key = req.headers['idempotency-key'] as string | undefined

      const result = await db.tenant(tenantId, async (q) =>
        useIdempotency(q, tenantId, key, req.body, async () => {
          const before = await repo.getEmployeeById(q, employeeId)
          if (!before) throw httpError.notFound('Employee not found')

          const after = await repo.updateEmployeeFields(q, employeeId, parsed.data as Record<string, unknown>)
          if (!after) throw httpError.notFound('Employee not found')

          const changed =
            after.jobTitle !== before.jobTitle ||
            after.departmentId !== before.departmentId ||
            after.managerEmployeeId !== before.managerEmployeeId
          if (changed) {
            await repo.insertEmploymentHistory(q, {
              id: newId(),
              tenantId,
              employeeId,
              effectiveDate: new Date().toISOString().slice(0, 10),
              jobTitle: after.jobTitle,
              departmentId: after.departmentId,
              managerEmployeeId: after.managerEmployeeId,
              employmentStatus: after.employmentStatus,
              changeReason: 'adjustment',
              createdBy: actorId,
            })
          }

          await audit(q, {
            tenantId,
            actorType: 'user',
            actorId,
            action: 'employee.updated',
            entityType: 'employee',
            entityId: employeeId,
            before: toResponse(before),
            after: toResponse(after),
            ip: req.ip,
          })
          return { status: 200, body: toResponse(after) }
        }),
      )
      return reply.code(result.status).send(result.body)
    },
  )

  fastify.delete(
    '/employees/:employeeId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.EMPLOYEE_WRITE)] },
    async (req, reply) => {
      const employeeId = (req.params as { employeeId: string }).employeeId
      const tenantId = req.ctx.tenantId
      const actorId = req.ctx.userId

      await db.tenant(tenantId, async (q) => {
        const before = await repo.getEmployeeById(q, employeeId)
        if (!before) throw httpError.notFound('Employee not found')
        const terminated = await repo.terminateEmployee(q, employeeId)
        if (!terminated) throw httpError.notFound('Employee not found')
        await repo.insertEmploymentHistory(q, {
          id: newId(),
          tenantId,
          employeeId,
          effectiveDate: terminated.terminationDate ?? new Date().toISOString().slice(0, 10),
          jobTitle: terminated.jobTitle,
          departmentId: terminated.departmentId,
          managerEmployeeId: terminated.managerEmployeeId,
          employmentStatus: 'terminated',
          changeReason: 'termination',
          createdBy: actorId,
        })
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId,
          action: 'employee.terminated',
          entityType: 'employee',
          entityId: employeeId,
          before: toResponse(before),
          after: toResponse(terminated),
          ip: req.ip,
        })
      })
      return reply.code(204).send()
    },
  )

  fastify.get(
    '/departments',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.EMPLOYEE_READ)] },
    async (req) => {
      return db.tenant(req.ctx.tenantId, async (q) => repo.listDepartments(q))
    },
  )

  fastify.post(
    '/departments',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.EMPLOYEE_WRITE)] },
    async (req, reply) => {
      const parsed = departmentCreateSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid department payload', parsed.error.flatten())
      const tenantId = req.ctx.tenantId
      const key = req.headers['idempotency-key'] as string | undefined
      const result = await db.tenant(tenantId, async (q) =>
        useIdempotency(q, tenantId, key, req.body, async () => {
          const department = await repo.insertDepartment(q, tenantId, parsed.data)
          return { status: 201, body: department }
        }),
      )
      return reply.code(result.status).send(result.body)
    },
  )
}
