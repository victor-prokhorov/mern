import IdempotencyKey from '../models/idempotencyKey.js'

export function claim({ key, user, requestFingerprint, expiresAt }) {
  return IdempotencyKey.create({ key, user, requestFingerprint, expiresAt })
}

export function findByKeyAndUser(key, user) {
  return IdempotencyKey.findOne({ key, user })
}

export function markCompleted(id, response) {
  return IdempotencyKey.findByIdAndUpdate(id, { $set: { status: 'completed', response } }, { returnDocument: 'after' })
}

export function release(id) {
  return IdempotencyKey.deleteOne({ _id: id })
}

export function reclaimStale({ key, user, requestFingerprint, expiresAt, staleBefore }) {
  return IdempotencyKey.findOneAndUpdate(
    { key, user, status: 'in_progress', requestFingerprint, claimedAt: { $lt: staleBefore } },
    { $set: { expiresAt, claimedAt: new Date() } },
    { returnDocument: 'after' }
  )
}
