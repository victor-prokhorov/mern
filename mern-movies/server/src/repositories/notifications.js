import Notification from '../models/notification.js'

function writeErrorCode(writeError) {
  if (writeError.err) return writeError.err.code
  return writeError.code
}

function isDuplicateKeyError(err) {
  if (Array.isArray(err.writeErrors)) return err.writeErrors.every((writeError) => writeErrorCode(writeError) === 11000)
  return err.code === 11000
}

export async function insertMany(docs) {
  if (docs.length === 0) return []
  try {
    return await Notification.insertMany(docs, { ordered: false })
  } catch (err) {
    if (isDuplicateKeyError(err)) return err.insertedDocs || []
    throw err
  }
}

export function findByUser(userId) {
  return Notification.find({ user: userId }).sort({ readAt: 1, createdAt: -1 })
}

export function findById(id) {
  return Notification.findById(id)
}

export function save(notification) {
  return notification.save()
}
