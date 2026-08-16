import * as products from '../services/products.js'

export function stats(req, res) {
  res.json(products.cacheStats())
}

export function reset(req, res) {
  products.resetCacheStats()
  res.json(products.cacheStats())
}
