import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requirePermission } from '../../http/auth.js'
import { httpError } from '../../http/errors.js'
import { useIdempotency } from '../../lib/idempotency.js'
import { audit } from '../../lib/audit.js'
import { newId } from '../../db/index.js'
import type { Q } from '../../db/index.js'
import { PERMISSIONS } from '../permissions.js'
import { canTransition, PIPELINE_STAGES, type Candidate, type JobOpening } from './ats.repo.js'
import * as repo from './ats.repo.js'
import * as employeesRepo from '../employees/employees.repo.js'
import * as onboardingRepo from '../onboarding/onboarding.repo.js'

const jobCreateSchema = z.object({
  title: z.string().min(1).max(200),
  departmentId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  employmentType: z.enum(['full_time', 'part_time', 'contractor']).default('full_time'),
  salaryMin: z.number().nonnegative().nullable().optional(),
  salaryMax: z.number().nonnegative().nullable().optional(),
  currency: z.string().min(3).max(3).default('USD'),
  description: z.string().max(20000).optional(),
  requirements: z.string().max(20000).optional(),
  headcount: z.number().int().min(1).max(999).default(1),
  status: z.enum(['draft', 'pending_approval']).optional(),
})

const jobPatchSchema = jobCreateSchema.omit({ status: true }).partial()

const jobDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'on_hold', 'closed']),
  note: z.string().max(500).optional(),
})

const candidateCreateSchema = z.object({
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(40).nullable().optional(),
  resumeText: z.string().max(50_000).optional(),
  source: z.enum(['referral', 'job_board', 'linkedin', 'careers_page', 'agency', 'other']).default('other'),
  stage: z.enum(PIPELINE_STAGES).optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().max(5000).optional(),
})

const candidatePatchSchema = candidateCreateSchema
  .omit({ stage: true })
  .partial()
  // PATCH semantics: nullable fields may be explicitly cleared.
  .extend({
    phone: z.string().max(40).nullable().optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
  })

const candidateTransitionSchema = z.object({
  stage: z.enum(PIPELINE_STAGES),
  note: z.string().max(500).optional(),
})

function pagination(qs: Record<string, string | undefined>) {
  return {
    page: Math.max(1, Number(qs.page ?? 1)),
    pageSize: Math.min(100, Math.max(1, Number(qs.pageSize ?? 25))),
  }
}

const DECISION_TARGET = {
  approved: 'open',
  rejected: 'closed',
  on_hold: 'on_hold',
  closed: 'closed',
} as const
const JOB_STATUSES = ['draft', 'pending_approval', 'open', 'on_hold', 'closed'] as const

function validateDecision(from: string, decision: string): void {
  switch (decision) {
    case 'approved':
      if (from !== 'draft' && from !== 'pending_approval' && from !== 'on_hold') {
        throw httpError.conflict(`Only a draft/pending/on-hold opening can be approved (current: ${from})`)
      }
      break
    case 'rejected':
      if (from !== 'draft' && from !== 'pending_approval') {
        throw httpError.conflict(`Only a draft or pending approval can be rejected (current: ${from})`)
      }
      break
    case 'on_hold':
      if (from !== 'open') throw httpError.conflict(`Only an open opening can be put on hold (current: ${from})`)
      break
    case 'closed':
      if (from !== 'open' && from !== 'on_hold') {
        throw httpError.conflict(`Only an open or on-hold opening can be closed (current: ${from})`)
      }
      break
  }
}

export interface HireResult {
  employeeId: string
  onboardingPlanId: string | null
}

/**
 * The "candidate → employee" domain event. Runs inside the transition's tenant
 * transaction: creates the employee from the candidate + job posting details,
 * records hire history, links the candidate, then auto-starts onboarding from
 * the tenant's default onboarding template (skipped when none is configured).
 */
async function hireCandidate(
  q: Q,
  params: {
    tenantId: string
    actorId: string
    ip: string | null
    candidate: Candidate
    opening: JobOpening
  },
): Promise<HireResult> {
  const { tenantId, actorId, ip, candidate, opening } = params

  let employee = null
  let employeeNumber = `EMP-${newId().slice(9, 13).toUpperCase()}`
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      employee = await employeesRepo.insertEmployee(q, {
        id: newId(),
        tenantId,
        employeeNumber,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        workEmail: candidate.email,
        departmentId: opening.departmentId ?? null,
        locationId: opening.locationId ?? null,
        managerEmployeeId: null,
        jobTitle: opening.title,
        employmentType: opening.employmentType || 'full_time',
        hireDate: new Date().toISOString().slice(0, 10),
        personalEmail: candidate.email,
        createdBy: actorId,
      })
      break
    } catch (err) {
      // Employee-number collision with an existing row: re-roll a fresh number.
      if (err instanceof Error && err.message === 'INSERT_CONFLICT_EMPLOYEE_NUMBER' && attempt < 4) {
        employeeNumber = `EMP-${newId().slice(9, 13).toUpperCase()}`
        continue
      }
      throw err
    }
  }
  if (!employee) throw new Error('INSERT_CONFLICT_EMPLOYEE_NUMBER')

  await employeesRepo.insertEmploymentHistory(q, {
    id: newId(),
    tenantId,
    employeeId: employee.id,
    effectiveDate: employee.hireDate,
    jobTitle: employee.jobTitle ?? null,
    departmentId: employee.departmentId ?? null,
    managerEmployeeId: null,
    employmentStatus: 'active',
    changeReason: 'hire',
    createdBy: actorId,
  })

  await repo.setCandidateHiredEmployee(q, candidate.id, employee.id)

  await audit(q, {
    tenantId,
    actorType: 'user',
    actorId,
    action: 'employee.hired',
    entityType: 'employee',
    entityId: employee.id,
    after: employee,
    ip,
  })

  const template = await onboardingRepo.getDefaultTemplate(q, tenantId, 'onboarding')
  if (!template) return { employeeId: employee.id, onboardingPlanId: null }

  const plan = await onboardingRepo.startPlan(q, {
    id: newId(),
    tenantId,
    employeeId: employee.id,
    kind: 'onboarding',
    templateId: template.id,
    source: 'system',
    createdBy: actorId,
  })
  await audit(q, {
    tenantId,
    actorType: 'user',
    actorId,
    action: 'onboarding.onboarding_started',
    entityType: 'onboarding_plan',
    entityId: plan.id,
    after: plan,
    ip,
  })
  return { employeeId: employee.id, onboardingPlanId: plan.id }
}

export function registerAtsRoutes(fastify: FastifyInstance): void {
  const { db } = fastify

  // --- Job openings (requisitions) ------------------------------------------

  fastify.get(
    '/job-openings',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_READ)] },
    async (req) => {
      const qs = req.query as Record<string, string | undefined>
      const { page, pageSize } = pagination(qs)
      const filter: repo.JobFilter = { status: qs.status, departmentId: qs.departmentId }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const { data, total } = await repo.listJobOpenings(q, filter, page, pageSize)
        return { data, page, pageSize, total }
      })
    },
  )

  fastify.post(
    '/job-openings',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_WRITE)] },
    async (req, reply) => {
      const parsed = jobCreateSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid job opening payload', parsed.error.flatten())
      const tenantId = req.ctx.tenantId
      const key = req.headers['idempotency-key'] as string | undefined

      const result = await db.tenant(tenantId, async (q) =>
        useIdempotency(q, tenantId, key, req.body, async () => {
          const opening = await repo.insertJobOpening(q, {
            id: newId(),
            tenantId,
            title: parsed.data.title,
            departmentId: parsed.data.departmentId ?? null,
            locationId: parsed.data.locationId ?? null,
            employmentType: parsed.data.employmentType,
            salaryMin: parsed.data.salaryMin ?? null,
            salaryMax: parsed.data.salaryMax ?? null,
            currency: parsed.data.currency,
            description: parsed.data.description ?? null,
            requirements: parsed.data.requirements ?? null,
            headcount: parsed.data.headcount,
            status: parsed.data.status ?? 'draft',
            createdBy: req.ctx.userId,
          })
          await audit(q, {
            tenantId,
            actorType: 'user',
            actorId: req.ctx.userId,
            action: 'ats.job_created',
            entityType: 'job_opening',
            entityId: opening.id,
            after: opening,
            ip: req.ip,
          })
          return { status: 201, body: opening }
        }),
      )
      return reply.code(result.status).send(result.body)
    },
  )

  fastify.get(
    '/job-openings/:jobId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_READ)] },
    async (req, reply) => {
      const jobId = (req.params as { jobId: string }).jobId
      return db.tenant(req.ctx.tenantId, async (q) => {
        const opening = await repo.getJobOpening(q, jobId)
        if (!opening) throw httpError.notFound('Job opening not found')
        return reply.send(opening)
      })
    },
  )

  fastify.patch(
    '/job-openings/:jobId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_WRITE)] },
    async (req, reply) => {
      const parsed = jobPatchSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid job opening payload', parsed.error.flatten())
      const jobId = (req.params as { jobId: string }).jobId
      const tenantId = req.ctx.tenantId

      await db.tenant(tenantId, async (q) => {
        const before = await repo.getJobOpening(q, jobId)
        if (!before) throw httpError.notFound('Job opening not found')
        const after = await repo.updateJobOpeningFields(q, jobId, parsed.data as Record<string, unknown>)
        if (!after) throw httpError.notFound('Job opening not found')
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'ats.job_updated',
          entityType: 'job_opening',
          entityId: jobId,
          before,
          after,
          ip: req.ip,
        })
      })
      const updated = await db.tenant(tenantId, (q) => repo.getJobOpening(q, jobId))
      return reply.send(updated)
    },
  )

  fastify.post(
    '/job-openings/:jobId/submit',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_WRITE)] },
    async (req, reply) => {
      const jobId = (req.params as { jobId: string }).jobId
      const tenantId = req.ctx.tenantId
      await db.tenant(tenantId, async (q) => {
        const before = await repo.getJobOpening(q, jobId)
        if (!before) throw httpError.notFound('Job opening not found')
        if (before.status !== 'draft') throw httpError.conflict(`Only a draft can be submitted for approval (current: ${before.status})`)
        const after = await repo.updateJobOpeningStatus(q, jobId, 'pending_approval')
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'ats.job_submitted',
          entityType: 'job_opening',
          entityId: jobId,
          before,
          after,
          ip: req.ip,
        })
      })
      return reply.send(await db.tenant(tenantId, (q) => repo.getJobOpening(q, jobId)))
    },
  )

  fastify.post(
    '/job-openings/:jobId/decision',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_APPROVE)] },
    async (req, reply) => {
      const parsed = jobDecisionSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid decision payload', parsed.error.flatten())
      const jobId = (req.params as { jobId: string }).jobId
      const tenantId = req.ctx.tenantId

      await db.tenant(tenantId, async (q) => {
        const before = await repo.getJobOpening(q, jobId)
        if (!before) throw httpError.notFound('Job opening not found')
        validateDecision(before.status, parsed.data.decision)
        const after = await repo.updateJobOpeningStatus(q, jobId, DECISION_TARGET[parsed.data.decision])
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: `ats.job_${parsed.data.decision}`,
          entityType: 'job_opening',
          entityId: jobId,
          before,
          after,
          ip: req.ip,
        })
      })
      return reply.send(await db.tenant(tenantId, (q) => repo.getJobOpening(q, jobId)))
    },
  )

  fastify.delete(
    '/job-openings/:jobId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_WRITE)] },
    async (req, reply) => {
      const jobId = (req.params as { jobId: string }).jobId
      const tenantId = req.ctx.tenantId
      await db.tenant(tenantId, async (q) => {
        const before = await repo.getJobOpening(q, jobId)
        if (!before) throw httpError.notFound('Job opening not found')
        await repo.softDeleteJobOpening(q, jobId)
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'ats.job_deleted',
          entityType: 'job_opening',
          entityId: jobId,
          before,
          ip: req.ip,
        })
      })
      return reply.code(204).send()
    },
  )

  // --- Candidates ------------------------------------------------------------

  fastify.get(
    '/job-openings/:jobId/candidates',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_READ)] },
    async (req) => {
      const jobId = (req.params as { jobId: string }).jobId
      const qs = req.query as Record<string, string | undefined>
      const { page, pageSize } = pagination(qs)
      const filter: repo.CandidateFilter = { stage: qs.stage }
      return db.tenant(req.ctx.tenantId, async (q) => {
        const opening = await repo.getJobOpening(q, jobId)
        if (!opening) throw httpError.notFound('Job opening not found')
        const { data, total } = await repo.listCandidates(q, jobId, filter, page, pageSize)
        return { data, page, pageSize, total }
      })
    },
  )

  fastify.post(
    '/job-openings/:jobId/candidates',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_WRITE)] },
    async (req, reply) => {
      const parsed = candidateCreateSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid candidate payload', parsed.error.flatten())
      const jobId = (req.params as { jobId: string }).jobId
      const tenantId = req.ctx.tenantId
      const key = req.headers['idempotency-key'] as string | undefined

      const result = await db.tenant(tenantId, async (q) =>
        useIdempotency(q, tenantId, key, req.body, async () => {
          const opening = await repo.getJobOpening(q, jobId)
          if (!opening) throw httpError.notFound('Job opening not found')
          const candidate = await repo.insertCandidate(q, {
            id: newId(),
            tenantId,
            jobOpeningId: jobId,
            firstName: parsed.data.firstName,
            lastName: parsed.data.lastName,
            email: parsed.data.email,
            phone: parsed.data.phone ?? null,
            resumeText: parsed.data.resumeText ?? null,
            source: parsed.data.source,
            stage: parsed.data.stage ?? 'sourced',
            rating: parsed.data.rating ?? null,
            notes: parsed.data.notes ?? null,
            createdBy: req.ctx.userId,
          })
          await audit(q, {
            tenantId,
            actorType: 'user',
            actorId: req.ctx.userId,
            action: 'ats.candidate_added',
            entityType: 'job_candidate',
            entityId: candidate.id,
            after: candidate,
            ip: req.ip,
          })
          return { status: 201, body: candidate }
        }),
      )
      return reply.code(result.status).send(result.body)
    },
  )

  fastify.get(
    '/candidates/:candidateId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_READ)] },
    async (req, reply) => {
      const candidateId = (req.params as { candidateId: string }).candidateId
      return db.tenant(req.ctx.tenantId, async (q) => {
        const candidate = await repo.getCandidate(q, candidateId)
        if (!candidate) throw httpError.notFound('Candidate not found')
        return reply.send(candidate)
      })
    },
  )

  fastify.patch(
    '/candidates/:candidateId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_WRITE)] },
    async (req, reply) => {
      const parsed = candidatePatchSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid candidate payload', parsed.error.flatten())
      const candidateId = (req.params as { candidateId: string }).candidateId
      const tenantId = req.ctx.tenantId

      await db.tenant(tenantId, async (q) => {
        const before = await repo.getCandidate(q, candidateId)
        if (!before) throw httpError.notFound('Candidate not found')
        const after = await repo.updateCandidateFields(q, candidateId, parsed.data as Record<string, unknown>)
        if (!after) throw httpError.notFound('Candidate not found')
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'ats.candidate_updated',
          entityType: 'job_candidate',
          entityId: candidateId,
          before,
          after,
          ip: req.ip,
        })
      })
      const updated = await db.tenant(tenantId, (q) => repo.getCandidate(q, candidateId))
      return reply.send(updated)
    },
  )

  fastify.post(
    '/candidates/:candidateId/transition',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_WRITE)] },
    async (req, reply) => {
      const parsed = candidateTransitionSchema.safeParse(req.body)
      if (!parsed.success) throw httpError.badRequest('Invalid transition payload', parsed.error.flatten())
      const candidateId = (req.params as { candidateId: string }).candidateId
      const tenantId = req.ctx.tenantId

      await db.tenant(tenantId, async (q) => {
        const before = await repo.getCandidate(q, candidateId)
        if (!before) throw httpError.notFound('Candidate not found')
        const check = canTransition(before.stage, parsed.data.stage)
        if (!check.ok) throw httpError.conflict(check.message ?? 'Invalid transition')
        const after = await repo.updateCandidateStage(q, candidateId, parsed.data.stage)
        let hire: HireResult | null = null
        // "candidate → employee" domain event: closing the offer creates the
        // employee and auto-starts onboarding from the default template.
        if (parsed.data.stage === 'hired' && !before.hiredEmployeeId) {
          const opening = await repo.getJobOpening(q, before.jobOpeningId)
          if (!opening) throw httpError.notFound('Job opening not found')
          hire = await hireCandidate(q, {
            tenantId,
            actorId: req.ctx.userId,
            ip: req.ip,
            candidate: before,
            opening,
          })
        }
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'ats.candidate_stage_changed',
          entityType: 'job_candidate',
          entityId: candidateId,
          before,
          after: { ...after, hiredEmployeeId: hire?.employeeId ?? after?.hiredEmployeeId ?? null },
          ip: req.ip,
        })
        return hire
      })
      return reply.send(await db.tenant(tenantId, (q) => repo.getCandidate(q, candidateId)))
    },
  )

  fastify.delete(
    '/candidates/:candidateId',
    { preHandler: [authenticate, requirePermission(PERMISSIONS.ATS_WRITE)] },
    async (req, reply) => {
      const candidateId = (req.params as { candidateId: string }).candidateId
      const tenantId = req.ctx.tenantId
      await db.tenant(tenantId, async (q) => {
        const before = await repo.getCandidate(q, candidateId)
        if (!before) throw httpError.notFound('Candidate not found')
        await repo.softDeleteCandidate(q, candidateId)
        await audit(q, {
          tenantId,
          actorType: 'user',
          actorId: req.ctx.userId,
          action: 'ats.candidate_deleted',
          entityType: 'job_candidate',
          entityId: candidateId,
          before,
          ip: req.ip,
        })
      })
      return reply.code(204).send()
    },
  )
}

export type { JobOpening, Candidate }
export { JOB_STATUSES, PIPELINE_STAGES }