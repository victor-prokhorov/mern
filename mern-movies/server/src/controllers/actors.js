import * as actors from '../services/actors.js'

export async function list(req, res) {
  res.json(await actors.list())
}

export async function create(req, res) {
  const actor = await actors.create({ userId: req.userId, name: req.body.name })
  res.status(201).json(actor)
}
