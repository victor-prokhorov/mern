const LIKED_MULTIPLIER = 1.2
const DISLIKED_MULTIPLIER = 0.8
const WATCHED_MULTIPLIER = 1.1
const RESULT_LIMIT = 10

function matchedGenres(genres, genreSet) {
  return genres.filter((genre) => genreSet.has(genre))
}

function score(movie, signals) {
  const genres = movie.genres || []
  const liked = matchedGenres(genres, signals.liked)
  const disliked = matchedGenres(genres, signals.disliked)
  const watched = matchedGenres(genres, signals.watched)
  let multiplier = 1
  const reasons = []
  if (liked.length > 0) {
    multiplier *= LIKED_MULTIPLIER
    liked.forEach((genre) => reasons.push(`LIKED_GENRE:${genre}`))
  }
  if (disliked.length > 0) {
    multiplier *= DISLIKED_MULTIPLIER
    disliked.forEach((genre) => reasons.push(`DISLIKED_GENRE:${genre}`))
  }
  if (watched.length > 0) {
    multiplier *= WATCHED_MULTIPLIER
    watched.forEach((genre) => reasons.push(`WATCHED_GENRE:${genre}`))
  }
  return { movie, score: movie.averageRating * multiplier, reasons }
}

export function rank(candidates, signals = {}) {
  const normalized = {
    liked: new Set(signals.likedGenres || []),
    disliked: new Set(signals.dislikedGenres || []),
    watched: new Set(signals.watchedGenres || [])
  }
  const scored = candidates.map((candidate) => score(candidate, normalized))
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const idA = String(a.movie._id)
    const idB = String(b.movie._id)
    if (idA < idB) return -1
    if (idA > idB) return 1
    return 0
  })
  return scored.slice(0, RESULT_LIMIT)
}
