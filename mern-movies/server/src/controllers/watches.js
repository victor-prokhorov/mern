import * as watches from '../services/watches.js'

export async function create(req, res) {
  const watch = await watches.create({ userId: req.userId, movieId: req.body.movieId })
  res.status(201).json(watch)
}
