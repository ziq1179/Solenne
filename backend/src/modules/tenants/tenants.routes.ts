import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { httpError } from '../../http/errors.js'
import { newId } from '../../db/index.js'
import { audit } from '../../lib/audit.js'
import { newOpaqueToken, scryptHash, sha256Hex } from '../../lib/crypto.js'
import { parseDuration } from '../../lib/duration.js'
import { seedPermissions, seedRolesForTenant } from '../../seed/seed.js'
import * as authRepo from '../auth/auth.repo.js'
import * as repo from './tenants.repo.js'

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const signupSchema = z.object({
  companyName: z.string().min(1).max(160),
  subdomain: z
    .string()
    .min(3)
    .max(63)
    .regex(SUBDOMAIN_RE, 'subdomain must be lowercase letters, numbers and dashes'),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8).max(128),
  adminFirstName: z.string().min(1).max(120),
  adminLastName: z.string().min(1).max(120),
})

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505'
}

export function registerTenantRoutes(fastify: FastifyInstance): void {
  const { db, config } = fastify
  const accessTtlSeconds = parseDuration(config.jwtExpires)

  fastify.post('/tenants/signup', async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body)
    if (!parsed.success) throw httpError.badRequest('Invalid signup payload', parsed.error.flatten())
    const body = parsed.data
    const subdomain = body.subdomain.toLowerCase()

    // The whole provisioning sequence runs in ONE system transaction (RLS
    // bypassed, like the seed): a failure at any step rolls the tenant back.
    const result = await db.system(async (q) => {
      const tenantId = newId()
      const adminUserId = newId()
      const employeeId = newId()
      const hireDate = new Date().toISOString().slice(0, 10)

      // Insert the tenant first so the subdomain UNIQUE constraint is the
      // authority on availability (idempotency helpers are tenant-scoped and
      // cannot run before a tenant exists).
      let tenant: repo.TenantRow
      try {
        tenant = await repo.insertTenant(q, { id: tenantId, name: body.companyName, subdomain })
      } catch (err) {
        if (isUniqueViolation(err)) throw httpError.conflict('That subdomain is already taken')
        throw err
      }

      const permissionIds = await seedPermissions(q)
      await seedRolesForTenant(q, tenantId, permissionIds)

      await repo.insertUser(q, {
        id: adminUserId,
        tenantId,
        email: body.adminEmail,
        passwordHash: await scryptHash(body.adminPassword),
      })

      for (const role of ['admin', 'employee']) {
        const roleId = await repo.findRoleIdByName(q, tenantId, role)
        if (roleId) await repo.assignUserRole(q, adminUserId, roleId, tenantId)
      }

      await repo.insertAdminEmployee(q, {
        id: employeeId,
        tenantId,
        userId: adminUserId,
        firstName: body.adminFirstName,
        lastName: body.adminLastName,
        workEmail: body.adminEmail,
        hireDate,
      })
      await repo.insertEmploymentHistory(q, { id: newId(), tenantId, employeeId, effectiveDate: hireDate })

      const leaveTypes = await repo.insertStandardLeaveTypes(q, tenantId)
      for (const leaveType of leaveTypes) {
        await repo.insertLeaveBalance(q, {
          tenantId,
          employeeId,
          leaveTypeId: leaveType.id,
          year: new Date().getFullYear(),
        })
      }

      await audit(q, {
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'tenant.provisioned',
        entityType: 'tenant',
        entityId: tenantId,
        after: { name: tenant.name, subdomain: tenant.subdomain, plan: tenant.plan },
        ip: req.ip,
      })

      // Issue auth tokens up front so signup = auto-login (same JWT shape as
      // /auth/login, so the client treats both endpoints identically).
      const [roles, permissions] = await Promise.all([
        authRepo.listRolesForUser(q, tenant.id, adminUserId),
        authRepo.listPermissionsForUser(q, tenant.id, adminUserId),
      ])
      const refreshToken = newOpaqueToken()
      await authRepo.insertRefreshToken(
        q,
        tenant.id,
        adminUserId,
        sha256Hex(refreshToken),
        new Date(Date.now() + config.refreshExpiresDays * 86_400_000),
      )

      return { tenant, adminUserId, employeeId, roles, permissions, refreshToken }
    })

    const accessToken = fastify.jwt.sign(
      {
        sub: result.adminUserId,
        tenant: result.tenant.id,
        employeeId: result.employeeId,
        roles: result.roles,
        permissions: result.permissions,
      },
      { expiresIn: config.jwtExpires },
    )

    return reply.code(201).send({
      accessToken,
      refreshToken: result.refreshToken,
      expiresIn: accessTtlSeconds,
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        subdomain: result.tenant.subdomain,
        plan: result.tenant.plan,
      },
    })
  })
}

export { isUniqueViolation }