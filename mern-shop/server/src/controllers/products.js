import * as products from '../services/products.js'

export async function list(req, res) {
  res.json(await products.list())
}

export async function get(req, res) {
  res.json(await products.get(req.params.id))
}
