import * as idempotencyKeysRepo from '../repositories/idempotencyKeys.js'
import { computeFingerprint } from '../idempotency/fingerprint.js'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export function idempotency({ store = idempotencyKeysRepo, ttlMs = DEFAULT_TTL_MS, userIdFrom }) {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.get('Idempotency-Key')
    if (!key) {
      next()
      return
    }
    const user = userIdFrom(req)
    const requestFingerprint = computeFingerprint(req.body)
    const expiresAt = new Date(Date.now() + ttlMs)
    let claimed
    try {
      claimed = await store.claim({ key, user, requestFingerprint, expiresAt })
    } catch (err) {
      if (err.code !== 11000) {
        next(err)
        return
      }
      const existing = await store.findByKeyAndUser(key, user)
      if (!existing) {
        next(err)
        return
      }
      if (existing.requestFingerprint !== requestFingerprint) {
        res.status(422).json({ error: 'idempotency key was reused with a different request body' })
        return
      }
      if (existing.status === 'in_progress') {
        res.set('Retry-After', '1')
        res.status(409).json({ error: 'a request with this idempotency key is already in progress' })
        return
      }
      res.set('Idempotent-Replay', 'true')
      res.status(existing.response.status).json(existing.response.body)
      return
    }
    const originalJson = res.json.bind(res)
    res.json = async (body) => {
      const status = res.statusCode
      const replayableBody = JSON.parse(JSON.stringify(body))
      try {
        if (status >= 500) {
          await store.release(claimed._id)
        } else {
          await store.markCompleted(claimed._id, { status, body: replayableBody })
        }
      } catch (err) {
        if (status < 500) await store.release(claimed._id).catch(() => {})
      }
      return originalJson(body)
    }
    next()
  }
}
