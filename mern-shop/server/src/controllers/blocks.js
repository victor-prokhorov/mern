import * as blocks from '../services/blocks.js'
import { UnauthorizedError } from '../middleware/error.js'

function requireAdmin(req) {
  const token = req.get('x-admin-token')
  if (!token || token !== process.env.ADMIN_TOKEN) throw new UnauthorizedError('invalid admin token')
}

export async function create(req, res) {
  requireAdmin(req)
  const createdBy = req.get('x-admin-name') || 'admin'
  const entry = await blocks.createBlock({ ...req.body, createdBy })
  res.status(201).json(entry)
}

export async function remove(req, res) {
  requireAdmin(req)
  await blocks.removeBlock(req.params.id)
  res.status(204).send()
}
