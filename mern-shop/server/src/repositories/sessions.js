import Session from '../models/session.js'

export function create(doc) {
  return Session.create(doc)
}

export function findByTokenHash(tokenHash) {
  return Session.findOne({ tokenHash })
}

export function consumeToken(tokenHash, now) {
  return Session.findOneAndUpdate(
    { tokenHash, usedAt: null, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: 'after' }
  )
}

export function markReplacedBy(id, replacedBy) {
  return Session.updateOne({ _id: id }, { $set: { replacedBy } })
}

export function revokeFamily(familyId, now) {
  return Session.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: now } })
}

export async function isFamilyRevoked(familyId) {
  const match = await Session.exists({ familyId, revokedAt: { $ne: null } })
  return Boolean(match)
}
