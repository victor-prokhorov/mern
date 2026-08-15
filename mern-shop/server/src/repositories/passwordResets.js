import PasswordReset from '../models/passwordReset.js'

export function create(doc) {
  return PasswordReset.create(doc)
}

export function findByTokenHash(tokenHash) {
  return PasswordReset.findOne({ tokenHash })
}

export function markUsed(id) {
  return PasswordReset.updateOne({ _id: id }, { usedAt: new Date() })
}

export function invalidateOthersForUser(userId, exceptId) {
  return PasswordReset.updateMany({ user: userId, _id: { $ne: exceptId }, usedAt: null }, { usedAt: new Date() })
}
