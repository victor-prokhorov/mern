import Watch from '../models/watch.js'

export function upsert(userId, movieId) {
  return Watch.findOneAndUpdate(
    { user: userId, movie: movieId },
    { $setOnInsert: { watchedAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  )
}

export function findByUser(userId) {
  return Watch.find({ user: userId })
}
