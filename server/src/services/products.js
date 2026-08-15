import { ObjectId } from 'mongodb'
import * as products from '../repositories/products.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export function list() {
  return products.findAll()
}

export async function get(id) {
  if (!ObjectId.isValid(id)) throw new BadRequestError('invalid product id')
  const product = await products.findById(id)
  if (!product) throw new NotFoundError('product not found')
  return product
}
