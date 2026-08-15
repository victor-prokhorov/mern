export function idempotency({ store, ttlMs, userIdFrom } = {}) {
  return function idempotencyMiddleware(req, res, next) {
    next()
  }
}
