import { ObjectId } from 'mongodb'
import * as ratingsRepo from '../repositories/ratings.js'
import * as moviesRepo from '../repositories/movies.js'
import { requireUser } from './authorize.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export async function upsert({ userId, movieId, value }) {
  await requireUser(userId)
  if (!ObjectId.isValid(movieId)) throw new BadRequestError('invalid movie id')
  if (!Number.isInteger(value) || value < 1 || value > 10) throw new BadRequestError('value must be an integer between 1 and 10')
  const movie = await moviesRepo.findById(movieId)
  if (!movie) throw new NotFoundError('movie not found')
  return ratingsRepo.upsert(userId, movieId, value)
}
