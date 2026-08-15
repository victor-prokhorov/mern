import { ObjectId } from 'mongodb'
import * as followsRepo from '../repositories/follows.js'
import * as actorsRepo from '../repositories/actors.js'
import { requireUser } from './authorize.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export async function follow(userId, actorId) {
  await requireUser(userId)
  if (!ObjectId.isValid(actorId)) throw new BadRequestError('invalid actor id')
  const actor = await actorsRepo.findById(actorId)
  if (!actor) throw new NotFoundError('actor not found')
  return followsRepo.upsert(userId, actorId)
}

export async function unfollow(userId, actorId) {
  await requireUser(userId)
  if (!ObjectId.isValid(actorId)) throw new BadRequestError('invalid actor id')
  return followsRepo.remove(userId, actorId)
}
