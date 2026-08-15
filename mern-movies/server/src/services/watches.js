import { ObjectId } from 'mongodb'
import * as watchesRepo from '../repositories/watches.js'
import * as moviesRepo from '../repositories/movies.js'
import { requireUser } from './authorize.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export async function create({ userId, movieId }) {
  await requireUser(userId)
  if (!ObjectId.isValid(movieId)) throw new BadRequestError('invalid movie id')
  const movie = await moviesRepo.findById(movieId)
  if (!movie) throw new NotFoundError('movie not found')
  return watchesRepo.upsert(userId, movieId)
}
