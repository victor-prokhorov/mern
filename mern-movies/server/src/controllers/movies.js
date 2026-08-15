import * as movies from '../services/movies.js'

export async function list(req, res) {
  res.json(await movies.list({ genre: req.query.genre }))
}

export async function get(req, res) {
  res.json(await movies.get(req.params.id))
}

export async function create(req, res) {
  const movie = await movies.create({ userId: req.userId, ...req.body })
  res.status(201).json(movie)
}
