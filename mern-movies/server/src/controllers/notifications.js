import * as notifications from '../services/notifications.js'

export async function list(req, res) {
  res.json(await notifications.list(req.userId))
}

export async function markRead(req, res) {
  res.json(await notifications.markRead(req.userId, req.params.id))
}
