import * as products from '../services/products.js'
import { NotFoundError } from '../middleware/error.js'

export async function get(req, res) {
  const result = await products.getProduct(req.params.id)
  res.set('X-Cache', result.source)
  if (result.value == null) throw new NotFoundError('product not found')
  res.json(result.value)
}

export async function list(req, res) {
  const found = await products.listProducts()
  res.json(found)
}

export async function create(req, res) {
  const product = await products.createProduct({ sku: req.body.sku, name: req.body.name, priceCents: req.body.priceCents, stock: req.body.stock })
  res.status(201).json(product)
}

export async function update(req, res) {
  const patch = {}
  if (req.body.name !== undefined) patch.name = req.body.name
  if (req.body.priceCents !== undefined) patch.priceCents = req.body.priceCents
  if (req.body.stock !== undefined) patch.stock = req.body.stock
  const product = await products.updateProduct(req.params.id, patch)
  if (!product) throw new NotFoundError('product not found')
  res.json(product)
}
