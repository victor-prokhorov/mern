import BlockedTerm from '../models/blockedTerm.js'

export function find() {
  return BlockedTerm.find()
}

export function create(doc) {
  return BlockedTerm.create(doc)
}

export function deleteAll() {
  return BlockedTerm.deleteMany({})
}
