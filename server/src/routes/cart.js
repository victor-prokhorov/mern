import { Router } from 'express'
import { ObjectId } from 'mongodb'
import Cart from '../models/cart.js'
import Product from '../models/product.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

const router = Router()

async function loadCart(cartId) {
  const existing = await Cart.findOne({ cartId })
  if (existing) return existing
  return Cart.create({ cartId, items: [] })
}

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

async function send(res, cart) {
  await cart.populate('items.product')
  res.json(cart)
}

router.get('/:cartId', async (req, res) => {
  const cart = await loadCart(req.params.cartId)
  await send(res, cart)
})

router.post('/:cartId/items', async (req, res) => {
  const qty = parseQty(req.body.qty)
  if (!ObjectId.isValid(req.body.productId)) throw new BadRequestError('invalid product id')
  const product = await Product.findById(req.body.productId)
  if (!product) throw new NotFoundError('product not found')
  const cart = await loadCart(req.params.cartId)
  const existing = cart.items.find((entry) => entry.product.toString() === req.body.productId)
  if (existing) existing.qty += qty
  else cart.items.push({ product: product._id, qty })
  await cart.save()
  await send(res, cart)
})

router.patch('/:cartId/items/:pid', async (req, res) => {
  const qty = parseQty(req.body.qty)
  const cart = await loadCart(req.params.cartId)
  const item = requireItem(cart, req.params.pid)
  item.qty = qty
  await cart.save()
  await send(res, cart)
})

router.delete('/:cartId/items/:pid', async (req, res) => {
  const cart = await loadCart(req.params.cartId)
  requireItem(cart, req.params.pid)
  cart.items = cart.items.filter((entry) => entry.product.toString() !== req.params.pid)
  await cart.save()
  await send(res, cart)
})

export default router
