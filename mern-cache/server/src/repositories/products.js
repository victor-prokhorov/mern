import mongoose from 'mongoose'
import Product from '../models/product.js'

let originReads = 0

export function originReadCount() {
  return originReads
}

export function resetOriginReadCount() {
  originReads = 0
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function findByIdSlow(id, delayMs = Number(process.env.ORIGIN_DELAY_MS ?? 15)) {
  originReads += 1
  if (delayMs > 0) await delay(delayMs)
  if (!mongoose.isValidObjectId(id)) return null
  return Product.findById(id).lean()
}

export function findAll() {
  return Product.find({}).lean()
}

export function update(id, patch) {
  return Product.findByIdAndUpdate(id, { $set: patch }, { returnDocument: 'after', runValidators: true }).lean()
}

export function create(doc) {
  return Product.create(doc)
}

export function insertMany(docs) {
  return Product.insertMany(docs)
}

export function deleteAll() {
  return Product.deleteMany({})
}
