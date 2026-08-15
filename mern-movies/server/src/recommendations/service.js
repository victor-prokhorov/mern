import * as ratingsRepo from '../repositories/ratings.js'
import * as watchesRepo from '../repositories/watches.js'
import * as moviesRepo from '../repositories/movies.js'
import { requireUser } from '../services/authorize.js'
import { rank } from './rank.js'

const ELIGIBILITY_FLOOR = 7
const LIKED_THRESHOLD = 5

function genresOf(movies) {
  return movies.flatMap((movie) => movie.genres || [])
}

export async function recommend(userId) {
  await requireUser(userId)
  const [ratings, watches] = await Promise.all([ratingsRepo.findByUser(userId), watchesRepo.findByUser(userId)])
  const ratedMovieIds = ratings.map((rating) => rating.movie.toString())
  const watchedMovieIds = watches.map((watch) => watch.movie.toString())
  const excludeIds = [...new Set([...ratedMovieIds, ...watchedMovieIds])]
  const likedMovieIds = ratings.filter((rating) => rating.value > LIKED_THRESHOLD).map((rating) => rating.movie)
  const dislikedMovieIds = ratings.filter((rating) => rating.value <= LIKED_THRESHOLD).map((rating) => rating.movie)
  const watchedUnratedMovieIds = watchedMovieIds.filter((id) => !ratedMovieIds.includes(id))
  const [likedMovies, dislikedMovies, watchedMovies, eligible] = await Promise.all([
    moviesRepo.findByIds(likedMovieIds),
    moviesRepo.findByIds(dislikedMovieIds),
    moviesRepo.findByIds(watchedUnratedMovieIds),
    moviesRepo.findEligible({ minAverageRating: ELIGIBILITY_FLOOR, excludeIds })
  ])
  const signals = {
    likedGenres: genresOf(likedMovies),
    dislikedGenres: genresOf(dislikedMovies),
    watchedGenres: genresOf(watchedMovies)
  }
  return rank(eligible, signals)
}
