import Actor from '../models/actor.js'

export function findAll() {
  return Actor.find({})
}

export function findById(id) {
  return Actor.findById(id)
}

export function findByIds(ids) {
  return Actor.find({ _id: { $in: ids } })
}

export function create(doc) {
  return Actor.create(doc)
}

export function insertMany(docs) {
  return Actor.insertMany(docs)
}

export function deleteAll() {
  return Actor.deleteMany({})
}
