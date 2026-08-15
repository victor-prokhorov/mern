import { ObjectId } from 'mongodb'
import * as usersRepo from '../repositories/users.js'
import { NotFoundError, UnauthorizedError } from '../middleware/error.js'

export async function requireUser(userId) {
  if (!userId || !ObjectId.isValid(userId)) throw new UnauthorizedError('x-user-id header is required')
  const user = await usersRepo.findById(userId)
  if (!user) throw new NotFoundError('user not found')
  return user
}

export async function requireAdmin(userId) {
  const user = await requireUser(userId)
  if (user.role !== 'admin') throw new UnauthorizedError('admin only')
  return user
}
