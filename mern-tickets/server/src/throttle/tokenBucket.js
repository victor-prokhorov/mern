import * as buckets from '../repositories/tokenBuckets.js'
import { TooManyRequestsError } from '../middleware/error.js'

export const RATES = {
  'ticket:create': { burst: 5, refillPerMinute: 1 },
  'comment:create': { burst: 20, refillPerMinute: 5 }
}

export function computeRefill(tokens, updatedAt, now, burst, refillPerMinute) {
  const elapsedMinutes = Math.max(0, (now.getTime() - updatedAt.getTime()) / 60000)
  return Math.min(burst, tokens + elapsedMinutes * refillPerMinute)
}

export function retryAfterSeconds(refilled, refillPerMinute) {
  const deficit = 1 - refilled
  return Math.max(1, Math.ceil((deficit / refillPerMinute) * 60))
}

async function loadOrCreate(key, burst, now) {
  const existing = await buckets.findByKey(key)
  if (existing) return existing
  try {
    return await buckets.create({ key, tokens: burst, updatedAt: now })
  } catch (err) {
    return buckets.findByKey(key)
  }
}

export async function consume(userId, action, now = new Date()) {
  const config = RATES[action]
  const key = `${userId}:${action}`
  for (let attempt = 0; attempt < 10; attempt++) {
    const doc = await loadOrCreate(key, config.burst, now)
    const refilled = computeRefill(doc.tokens, doc.updatedAt, now, config.burst, config.refillPerMinute)
    if (refilled < 1) {
      return { allowed: false, tokens: refilled, retryAfter: retryAfterSeconds(refilled, config.refillPerMinute) }
    }
    const updated = await buckets.updateIfUnchanged(
      { _id: doc._id, updatedAt: doc.updatedAt, tokens: doc.tokens },
      { tokens: refilled - 1, updatedAt: now }
    )
    if (updated) return { allowed: true, tokens: updated.tokens }
  }
  return { allowed: false, tokens: 0, retryAfter: 1 }
}

export async function throttle(userId, action) {
  const result = await consume(userId, action)
  if (!result.allowed) throw new TooManyRequestsError('too many requests', result.retryAfter)
  return result
}
