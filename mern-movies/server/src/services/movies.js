import { ObjectId } from 'mongodb'
import * as moviesRepo from '../repositories/movies.js'
import { requireAdmin } from './authorize.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export function list({ genre } = {}) {
  const filter = genre ? { genres: genre } : {}
  return moviesRepo.findAll(filter)
}

export async function get(id) {
  if (!ObjectId.isValid(id)) throw new BadRequestError('invalid movie id')
  const movie = await moviesRepo.findById(id)
  if (!movie) throw new NotFoundError('movie not found')
  return movie
}

export async function create({ userId, title, genres, cast, averageRating, releasedAt }) {
  await requireAdmin(userId)
  if (!title) throw new BadRequestError('title is required')
  const castIds = cast || []
  if (castIds.some((id) => !ObjectId.isValid(id))) throw new BadRequestError('invalid actor id in cast')
  const movie = await moviesRepo.create({ title, genres: genres || [], cast: castIds, averageRating, releasedAt })
  return movie
}
