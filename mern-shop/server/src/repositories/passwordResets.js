import PasswordReset from '../models/passwordReset.js'

export function create(doc) {
  return PasswordReset.create(doc)
}

export function consumeToken(tokenHash, now) {
  return PasswordReset.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: 'after' }
  )
}

export function invalidateOthersForUser(userId, exceptId) {
  return PasswordReset.updateMany({ user: userId, _id: { $ne: exceptId }, usedAt: null }, { usedAt: new Date() })
}
