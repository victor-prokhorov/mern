import * as documentsService from '../services/documents.js'

export async function tick(req, res) {
  const ticked = await documentsService.tick()
  res.status(200).json({ ticked })
}

export async function state(req, res) {
  const result = await documentsService.replicationState()
  res.status(200).json(result)
}
