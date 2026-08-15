import crypto from 'node:crypto'
import * as blocks from '../services/blocks.js'
import { UnauthorizedError } from '../middleware/error.js'

function safeEqual(a, b) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function requireAdmin(req) {
  const token = req.get('x-admin-token')
  const expected = process.env.ADMIN_TOKEN
  if (!token || !expected || !safeEqual(token, expected)) throw new UnauthorizedError('invalid admin token')
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
