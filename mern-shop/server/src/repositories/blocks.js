import BlockEntry from '../models/blockEntry.js'
import User from '../models/user.js'

export function createEntry(doc) {
  return BlockEntry.create(doc)
}

export function deleteEntry(id) {
  return BlockEntry.findByIdAndDelete(id)
}

export function findEntryById(id) {
  return BlockEntry.findById(id)
}

export function findEntryByTypeAndValue(type, value) {
  return BlockEntry.findOne({ type, value })
}

export function blockUser(userId, reason) {
  return User.updateOne({ _id: userId }, { blockedAt: new Date(), blockReason: reason })
}

export function unblockUser(userId) {
  return User.updateOne({ _id: userId }, { blockedAt: null, blockReason: null })
}
