import * as idempotencyKeysRepo from '../repositories/idempotencyKeys.js'
import { computeFingerprint } from '../idempotency/fingerprint.js'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_LEASE_MS = 30 * 1000

export function idempotency({ store = idempotencyKeysRepo, ttlMs = DEFAULT_TTL_MS, leaseMs = DEFAULT_LEASE_MS, userIdFrom }) {
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
      if (existing.status === 'completed') {
        res.set('Idempotent-Replay', 'true')
        res.status(existing.response.status).json(existing.response.body)
        return
      }
      const staleBefore = new Date(Date.now() - leaseMs)
      if (existing.claimedAt > staleBefore) {
        res.set('Retry-After', '1')
        res.status(409).json({ error: 'a request with this idempotency key is already in progress' })
        return
      }
      const reclaimed = await store.reclaimStale({ key, user, requestFingerprint, expiresAt, staleBefore })
      if (!reclaimed) {
        res.set('Retry-After', '1')
        res.status(409).json({ error: 'a request with this idempotency key is already in progress' })
        return
      }
      claimed = reclaimed
    }
    const originalJson = res.json.bind(res)
    res.json = async (body) => {
      const status = res.statusCode
      const replayableBody = JSON.parse(JSON.stringify(body))
      try {
        if (status >= 500) {
          const released = await store.release(claimed._id, claimed.epoch)
          if (released.deletedCount === 0) {
            console.warn(`idempotency: release for key=${key} user=${user} was superseded by a later claim epoch, left the newer claim untouched`)
          }
        } else {
          const completed = await store.markCompleted(claimed._id, claimed.epoch, { status, body: replayableBody })
          if (!completed) {
            console.warn(`idempotency: markCompleted for key=${key} user=${user} was superseded by a later claim epoch, left the newer claim untouched`)
          }
        }
      } catch (err) {
        console.error(`idempotency: failed to persist claim outcome for key=${key} user=${user} status=${status}`, err)
      }
      return originalJson(body)
    }
    next()
  }
}
