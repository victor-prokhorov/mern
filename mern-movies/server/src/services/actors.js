import * as actorsRepo from '../repositories/actors.js'
import { requireAdmin } from './authorize.js'
import { BadRequestError } from '../middleware/error.js'

export function list() {
  return actorsRepo.findAll()
}

export async function create({ userId, name }) {
  await requireAdmin(userId)
  if (!name) throw new BadRequestError('name is required')
  return actorsRepo.create({ name })
}
