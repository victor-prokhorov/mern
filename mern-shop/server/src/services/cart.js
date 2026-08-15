import { ObjectId } from 'mongodb'
import * as carts from '../repositories/carts.js'
import * as products from '../repositories/products.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

function parseQty(value) {
  if (!Number.isInteger(value) || value < 1) throw new BadRequestError('qty must be a positive integer')
  return value
}

function requireItem(cart, productId) {
  if (!ObjectId.isValid(productId)) throw new BadRequestError('invalid product id')
  const item = cart.items.find((entry) => entry.product.toString() === productId)
  if (!item) throw new NotFoundError('item not in cart')
  return item
}

async function withoutStaleLines(cart) {
  await carts.populate(cart)
  const before = cart.items.length
  cart.items = cart.items.filter((entry) => entry.product !== null)
  if (cart.items.length !== before) await carts.save(cart)
  return cart
}

export async function view(cartId) {
  const cart = await carts.loadOrCreate(cartId)
  return withoutStaleLines(cart)
}

export async function addItem(cartId, productId, qty) {
  const quantity = parseQty(qty)
  if (!ObjectId.isValid(productId)) throw new BadRequestError('invalid product id')
  const product = await products.findById(productId)
  if (!product) throw new NotFoundError('product not found')
  const cart = await carts.loadOrCreate(cartId)
  const existing = cart.items.find((entry) => entry.product.toString() === productId)
  if (existing) existing.qty += quantity
  else cart.items.push({ product: product._id, qty: quantity })
  await carts.save(cart)
  return withoutStaleLines(cart)
}

export async function changeQty(cartId, productId, qty) {
  const quantity = parseQty(qty)
  const cart = await carts.loadOrCreate(cartId)
  const item = requireItem(cart, productId)
  item.qty = quantity
  await carts.save(cart)
  return withoutStaleLines(cart)
}

export async function removeItem(cartId, productId) {
  const cart = await carts.loadOrCreate(cartId)
  requireItem(cart, productId)
  cart.items = cart.items.filter((entry) => entry.product.toString() !== productId)
  await carts.save(cart)
  return withoutStaleLines(cart)
}
