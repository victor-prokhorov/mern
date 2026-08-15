import Rating from '../models/rating.js'

export function upsert(userId, movieId, value) {
  return Rating.findOneAndUpdate(
    { user: userId, movie: movieId },
    { $set: { value }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  )
}

export function findByUser(userId) {
  return Rating.find({ user: userId })
}

export function findByUserAndMovies(userId, movieIds) {
  return Rating.find({ user: userId, movie: { $in: movieIds } })
}
