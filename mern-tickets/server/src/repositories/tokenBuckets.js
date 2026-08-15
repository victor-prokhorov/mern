import TokenBucket from '../models/tokenBucket.js'

export function findByKey(key) {
  return TokenBucket.findOne({ key })
}

export function create(doc) {
  return TokenBucket.create(doc)
}

export function updateIfUnchanged(filter, update) {
  return TokenBucket.findOneAndUpdate(filter, update, { returnDocument: 'after' })
}

export function deleteAll() {
  return TokenBucket.deleteMany({})
}
