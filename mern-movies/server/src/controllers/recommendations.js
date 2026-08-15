import { recommend } from '../recommendations/service.js'

export async function list(req, res) {
  res.json(await recommend(req.userId))
}
