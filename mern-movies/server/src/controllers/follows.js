import * as follows from '../services/follows.js'

export async function follow(req, res) {
  await follows.follow(req.userId, req.params.id)
  res.status(201).json({ following: true })
}

export async function unfollow(req, res) {
  await follows.unfollow(req.userId, req.params.id)
  res.status(200).json({ following: false })
}
