import { Router } from 'express'
import { ObjectId } from 'mongodb'
import Cart from '../models/cart.js'
import Order from '../models/order.js'
import User from '../models/user.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

const router = Router()

router.post('/', async (req, res) => {
  const { cartId, userId, customer } = req.body
  if (!ObjectId.isValid(userId)) throw new BadRequestError('invalid user id')
  const user = await User.findById(userId)
  if (!user) throw new NotFoundError('user not found')
  const cart = await Cart.findOne({ cartId }).populate('items.product')
  if (!cart || cart.items.length === 0) throw new BadRequestError('cart is empty')
  if (cart.items.some((entry) => entry.product === null)) throw new BadRequestError('cart contains an unavailable product')
  const items = cart.items.map((entry) => ({
    product: entry.product._id,
    name: entry.product.name,
    price: entry.product.price,
    qty: entry.qty
  }))
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0)
  const order = await Order.create({ user: user._id, items, total, customer })
  cart.items = []
  await cart.save()
  res.status(201).json(order)
})

router.get('/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) throw new BadRequestError('invalid order id')
  const order = await Order.findById(req.params.id)
  if (!order) throw new NotFoundError('order not found')
  res.json(order)
})

export default router
