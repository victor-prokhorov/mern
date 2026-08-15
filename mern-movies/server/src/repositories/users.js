import User from '../models/user.js'

export function findById(id) {
  return User.findById(id)
}

export function findByEmail(email) {
  return User.findOne({ email })
}

export function create(doc) {
  return User.create(doc)
}

export function insertMany(docs) {
  return User.insertMany(docs)
}

export function deleteAll() {
  return User.deleteMany({})
}
