import mongoose from 'mongoose'
import * as productsRepo from '../repositories/products.js'
import { createStore } from '../cache/store.js'
import { createCache } from '../cache/productCache.js'
import { BadRequestError } from '../middleware/error.js'

const TTL_MS = Number(process.env.CACHE_TTL_MS ?? 30000)
const NEGATIVE_TTL_MS = Number(process.env.CACHE_NEGATIVE_TTL_MS ?? 5000)

const store = createStore()

const cache = createCache({
  store,
  loader: (id) => productsRepo.findByIdSlow(id),
  ttlMs: TTL_MS,
  negativeTtlMs: NEGATIVE_TTL_MS
})

export function getProduct(id) {
  if (!mongoose.isValidObjectId(id)) throw new BadRequestError('invalid product id')
  return cache.get(id)
}

export function listProducts() {
  return productsRepo.findAll()
}

export async function createProduct(doc) {
  const product = await productsRepo.create(doc)
  cache.invalidate(product._id.toString())
  return product
}

export async function updateProduct(id, patch) {
  if (!mongoose.isValidObjectId(id)) throw new BadRequestError('invalid product id')
  const product = await productsRepo.update(id, patch)
  cache.invalidate(id)
  return product
}

export function cacheStats() {
  return { size: cache.size(), originReads: productsRepo.originReadCount() }
}

export function resetCacheStats() {
  store.clear()
  productsRepo.resetOriginReadCount()
}
