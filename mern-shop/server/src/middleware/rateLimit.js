import * as rateLimitsRepo from '../repositories/rateLimits.js'

export function rateLimit({ limit, windowMs, keyBy, store = rateLimitsRepo }) {
  return async function rateLimitMiddleware(req, res, next) {
    const key = keyBy(req)
    const now = Date.now()
    const windowStart = Math.floor(now / windowMs) * windowMs
    const windowEnd = windowStart + windowMs
    let doc
    try {
      doc = await store.incrementWindow(key, windowStart, new Date(windowEnd))
    } catch (err) {
      next()
      return
    }
    const remaining = Math.max(limit - doc.count, 0)
    const resetSeconds = Math.max(Math.ceil((windowEnd - now) / 1000), 0)
    const blocked = doc.count > limit
    const reported = res.get('RateLimit-Remaining')
    if (blocked || reported === undefined || remaining < Number(reported)) {
      res.set('RateLimit-Limit', String(limit))
      res.set('RateLimit-Remaining', String(remaining))
      res.set('RateLimit-Reset', String(resetSeconds))
    }
    if (blocked) {
      res.set('Retry-After', String(resetSeconds))
      res.status(429).json({ error: 'too many requests' })
      return
    }
    next()
  }
}
