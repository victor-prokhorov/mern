import Follow from '../models/follow.js'

export function upsert(userId, actorId) {
  return Follow.findOneAndUpdate(
    { user: userId, actor: actorId },
    { $setOnInsert: { createdAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  )
}

export function remove(userId, actorId) {
  return Follow.deleteOne({ user: userId, actor: actorId })
}

export function findByActors(actorIds) {
  return Follow.find({ actor: { $in: actorIds } })
}
