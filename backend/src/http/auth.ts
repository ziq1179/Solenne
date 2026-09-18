import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db/index.js'
import type { Config } from '../config.js'
import { httpError } from './errors.js'

export interface AuthClaims {
  sub: string
  tenant: string
  employeeId: string | null
  roles: string[]
  permissions: string[]
}

export interface RequestContext {
  /** Authenticated user account id. */
  userId: string
  /** Tenant the request is scoped to. */
  tenantId: string
  /** Linked employee record, when the user has one. */
  employeeId: string | null
  roles: string[]
  permissions: string[]
  /** People-facing roles that may browse the whole directory. */
  isDirectoryRole: boolean
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db
    config: Config
  }
  interface FastifyRequest {
    ctx: RequestContext
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthClaims
    user: AuthClaims
  }
}

const DIRECTORY_ROLES = ['admin', 'hr_manager', 'manager']

/** Verifies the Bearer JWT and projects its claims into `request.ctx`. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  let claims: AuthClaims
  try {
    await req.jwtVerify()
    claims = req.user
  } catch {
    throw httpError.unauthorized()
  }
  // `tenantId` feeding SET LOCAL may ONLY come from the verified JWT. Refuse
  // malformed claims outright — a falsy tenant would silently match zero rows
  // instead of failing.
  if (typeof claims.sub !== 'string' || claims.sub === '' || typeof claims.tenant !== 'string' || claims.tenant === '') {
    throw httpError.unauthorized('Token is missing required claims')
  }
  req.ctx = {
    userId: claims.sub,
    tenantId: claims.tenant,
    employeeId: claims?.employeeId ?? null,
    roles: claims?.roles ?? [],
    permissions: claims?.permissions ?? [],
    isDirectoryRole: (claims?.roles ?? []).some((r) => DIRECTORY_ROLES.includes(r)),
  }
}

/** Returns a preHandler that rejects the request unless it holds every permission. */
export function requirePermission(
  ...perms: string[]
): (req: FastifyRequest, _reply: FastifyReply) => Promise<void> {
  // Must return a promise: on this Node/Fastify combo a sync hook resolving
  // to `undefined` stalls the hook runner (follow-up hooks never run).
  return async (req) => {
    const held = new Set(req.ctx?.permissions ?? [])
    const missing = perms.filter((p) => !held.has(p))
    if (missing.length > 0) {
      throw httpError.forbidden(`Missing permission: ${missing.join(', ')}`)
    }
  }
}