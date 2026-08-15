import * as followsRepo from '../repositories/follows.js'
import * as notificationsRepo from '../repositories/notifications.js'

export async function fanoutNewMovie(movie) {
  const castIds = (movie.cast || []).map((id) => id.toString())
  if (castIds.length === 0) return []
  const follows = await followsRepo.findByActors(castIds)
  if (follows.length === 0) return []
  const docs = follows.map((follow) => ({
    user: follow.user,
    type: 'actor_in_new_movie',
    actor: follow.actor,
    movie: movie._id
  }))
  return notificationsRepo.insertMany(docs)
}
