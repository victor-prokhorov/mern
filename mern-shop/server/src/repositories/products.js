import Product from '../models/product.js'

export function findAll() {
  return Product.find({})
}

export function findById(id) {
  return Product.findById(id)
}

export function deleteAll() {
  return Product.deleteMany({})
}

export function insertMany(docs) {
  return Product.insertMany(docs)
}
