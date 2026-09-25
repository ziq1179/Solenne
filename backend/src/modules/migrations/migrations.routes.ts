import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { httpError } from '../../http/errors.js'
import { requirePermission } from '../../http/auth.js'
import {
  abortMigration,
  copyMigration,
  cutoverMigration,
  failMigration,
  getActiveMigration,
  getMigration,
  prepareMigration,
  purgeMigration,
  rollbackMigration,
  tenantIsolation,
  verifyMigration,
} from './migrations.repo.js'

const tenantIdParam = z.object({ tenantId: z.string().uuid() })
const migrationParam = z.object({ migrationId: z.string().uuid() })

const VERIFY_MISMATCH = /^verify_mismatch /

/** Platform-operator surface for the dedicated-tenant migration machine. */
export function registerMigrationRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  fastify.get(
    '/tenants/:tenantId/migrations',
    { preHandler: requirePermission('tenant:read') },
    async (req) => {
      const { tenantId } = tenantIdParam.parse(req.params)
      const active = await getActiveMigration(db, tenantId)
      const tenant = await tenantIsolation(db, tenantId)
      return { tenant, active }
    },
  )

  fastify.post(
    '/tenants/:tenantId/migrations/start',
    { preHandler: requirePermission('tenant:write') },
    async (req) => {
      const { tenantId } = tenantIdParam.parse(req.params)
      const migration = await prepareMigration(db, tenantId)
      const copied = await copyMigration(db, migration.migrationId)
      return { migration: copied }
    },
  )

  fastify.post(
    '/tenants/:tenantId/migrations/verify',
    { preHandler: requirePermission('tenant:write') },
    async (req) => {
      const { tenantId } = tenantIdParam.parse(req.params)
      const active = await getActiveMigration(db, tenantId)
      if (!active) throw httpError.notFound('No in-flight migration for tenant')
      try {
        const migration = await verifyMigration(db, active.migrationId)
        return { migration }
      } catch (err) {
        // Mismatch is the state-machine's failure path, not a 500.
        if (err instanceof Error && VERIFY_MISMATCH.test(err.message)) {
          const migration = await failMigration(db, active.migrationId, err.message)
          return { migration, failed: true, reason: err.message }
        }
        throw err
      }
    },
  )

  fastify.post(
    '/tenants/:tenantId/migrations/cutover',
    { preHandler: requirePermission('tenant:write') },
    async (req) => {
      const { tenantId } = tenantIdParam.parse(req.params)
      const active = await getActiveMigration(db, tenantId)
      if (!active) throw httpError.notFound('No in-flight migration for tenant')
      const migration = await cutoverMigration(db, active.migrationId)
      return { migration }
    },
  )

  fastify.post(
    '/tenants/:tenantId/migrations/purge',
    { preHandler: requirePermission('tenant:write') },
    async (req) => {
      const { tenantId } = tenantIdParam.parse(req.params)
      const active = await getActiveMigration(db, tenantId)
      if (!active) throw httpError.notFound('No in-flight migration for tenant')
      const migration = await purgeMigration(db, active.migrationId)
      return { migration }
    },
  )

  fastify.post(
    '/tenants/:tenantId/migrations/abort',
    { preHandler: requirePermission('tenant:write') },
    async (req) => {
      const { tenantId } = tenantIdParam.parse(req.params)
      const active = await getActiveMigration(db, tenantId)
      if (!active) throw httpError.notFound('No in-flight migration for tenant')
      const migration = await abortMigration(db, active.migrationId)
      return { migration }
    },
  )

  fastify.post(
    '/tenants/:tenantId/migrations/rollback',
    { preHandler: requirePermission('tenant:write') },
    async (req) => {
      const { tenantId } = tenantIdParam.parse(req.params)
      const active = await getActiveMigration(db, tenantId)
      if (!active) throw httpError.notFound('No in-flight migration for tenant')
      const migration = await rollbackMigration(db, active.migrationId)
      return { migration }
    },
  )

  fastify.post(
    '/tenants/:tenantId/migrations/:migrationId/abort',
    { preHandler: requirePermission('tenant:write') },
    async (req) => {
      const { migrationId } = migrationParam.parse(req.params)
      const migration = await abortMigration(db, migrationId)
      return { migration }
    },
  )

  fastify.post(
    '/tenants/:tenantId/migrations/:migrationId/rollback',
    { preHandler: requirePermission('tenant:write') },
    async (req) => {
      const { migrationId } = migrationParam.parse(req.params)
      const migration = await rollbackMigration(db, migrationId)
      return { migration }
    },
  )

  fastify.get(
    '/tenants/:tenantId/migrations/:migrationId',
    { preHandler: requirePermission('tenant:read') },
    async (req) => {
      const { migrationId } = migrationParam.parse(req.params)
      const migration = await getMigration(db, migrationId)
      if (!migration) throw httpError.notFound('Migration not found')
      return { migration }
    },
  )
}