import { logger } from '../observability/logger.js'

export class NotFoundError extends Error {
  constructor(message) {
    super(message)
    this.status = 404
  }
}

export class BadRequestError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

export class UnauthorizedError extends Error {
  constructor(message) {
    super(message)
    this.status = 401
  }
}

export class ForbiddenError extends Error {
  constructor(message) {
    super(message)
    this.status = 403
  }
}

export class TooManyRequestsError extends Error {
  constructor(message, retryAfter) {
    super(message)
    this.status = 429
    this.retryAfter = retryAfter
  }
}

export class PreconditionFailedError extends Error {
  constructor(message, version, ticket) {
    super(message)
    this.status = 412
    this.version = version
    this.ticket = ticket
  }
}

export class PreconditionRequiredError extends Error {
  constructor(message) {
    super(message)
    this.status = 428
  }
}

export function errorHandler(err, req, res, next) {
  if (err.name === 'ValidationError' || err.name === 'CastError') {
    return res.status(400).json({ error: err.message })
  }
  if (err.status === 429 || err.status === 503) {
    if (err.retryAfter !== undefined) res.set('Retry-After', String(err.retryAfter))
    return res.status(err.status).json({ error: err.message })
  }
  if (err.status === 412) {
    return res.status(412).json({ error: err.message, version: err.version, ticket: err.ticket })
  }
  if (err.status) return res.status(err.status).json({ error: err.message })
  logger.error('unhandled error', { error: err.message, stack: err.stack })
  res.status(500).json({ error: 'internal server error' })
}
