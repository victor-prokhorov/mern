import * as ratings from '../services/ratings.js'

export async function upsert(req, res) {
  const rating = await ratings.upsert({ userId: req.userId, movieId: req.body.movieId, value: req.body.value })
  res.status(201).json(rating)
}
