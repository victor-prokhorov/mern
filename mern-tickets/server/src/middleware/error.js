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

export function errorHandler(err, req, res, next) {
  if (err.name === 'ValidationError' || err.name === 'CastError') {
    return res.status(400).json({ error: err.message })
  }
  if (err.status === 429 || err.status === 503) {
    if (err.retryAfter !== undefined) res.set('Retry-After', String(err.retryAfter))
    return res.status(err.status).json({ error: err.message })
  }
  if (err.status) return res.status(err.status).json({ error: err.message })
  res.status(500).json({ error: 'internal server error' })
}
