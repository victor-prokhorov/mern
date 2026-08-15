import Movie from '../models/movie.js'

export function findAll(filter) {
  return Movie.find(filter || {})
}

export function findById(id) {
  return Movie.findById(id)
}

export function findByIds(ids) {
  return Movie.find({ _id: { $in: ids } })
}

export function findEligible({ minAverageRating, excludeIds }) {
  return Movie.find({ averageRating: { $gte: minAverageRating }, _id: { $nin: excludeIds } })
}

export function create(doc) {
  return Movie.create(doc)
}

export function insertMany(docs) {
  return Movie.insertMany(docs)
}

export function deleteAll() {
  return Movie.deleteMany({})
}
