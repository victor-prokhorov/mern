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

export class ConflictError extends Error {
  constructor(message) {
    super(message)
    this.status = 409
  }
}

export function errorHandler(err, req, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message })
  console.error('unhandled error', err)
  res.status(500).json({ error: 'internal server error' })
}
