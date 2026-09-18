import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: unknown

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export const httpError = {
  badRequest: (message = 'Bad request', details?: unknown) =>
    new AppError(400, 'BAD_REQUEST', message, details),
  unauthorized: (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'Insufficient permissions') => new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message),
  conflict: (message = 'Conflict with existing state') => new AppError(409, 'CONFLICT', message),
  unprocessable: (message = 'Request could not be processed', details?: unknown) =>
    new AppError(422, 'UNPROCESSABLE_ENTITY', message, details),
  internal: (message = 'Internal server error') => new AppError(500, 'INTERNAL', message),
}

export function registerErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      })
    }
    const statusCode = err.statusCode ?? 500
    if (statusCode >= 500) {
      request.log.error({ err }, 'unhandled error')
      return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } })
    }
    return reply.status(statusCode).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: err.message || 'Request validation failed',
        details: err.validation,
      },
    })
  })
}