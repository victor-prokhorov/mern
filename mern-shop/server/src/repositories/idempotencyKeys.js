import IdempotencyKey from '../models/idempotencyKey.js'

export function claim({ key, user, requestFingerprint, expiresAt }) {
  return IdempotencyKey.create({ key, user, requestFingerprint, expiresAt, epoch: 1 })
}

export function findByKeyAndUser(key, user) {
  return IdempotencyKey.findOne({ key, user })
}

export function markCompleted(id, epoch, response) {
  return IdempotencyKey.findOneAndUpdate({ _id: id, epoch }, { $set: { status: 'completed', response } }, { returnDocument: 'after' })
}

export function release(id, epoch) {
  return IdempotencyKey.deleteOne({ _id: id, epoch })
}

export function reclaimStale({ key, user, requestFingerprint, expiresAt, staleBefore }) {
  return IdempotencyKey.findOneAndUpdate(
    { key, user, status: 'in_progress', requestFingerprint, claimedAt: { $lt: staleBefore } },
    { $set: { expiresAt, claimedAt: new Date() }, $inc: { epoch: 1 } },
    { returnDocument: 'after' }
  )
}
