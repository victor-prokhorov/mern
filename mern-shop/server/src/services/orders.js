import { ObjectId } from 'mongodb'
import * as carts from '../repositories/carts.js'
import * as orders from '../repositories/orders.js'
import * as users from '../repositories/users.js'
import * as orderStats from '../repositories/orderStats.js'
import * as blocks from './blocks.js'
import { evaluateSignals, VELOCITY_WINDOW_MS } from '../fraud/signals.js'
import { score as scoreSignals } from '../fraud/score.js'
import { BadRequestError, ForbiddenError, NotFoundError } from '../middleware/error.js'

export async function place({ cartId, userId, customer }) {
  if (!ObjectId.isValid(userId)) throw new BadRequestError('invalid user id')
  const user = await users.findById(userId)
  if (!user) throw new NotFoundError('user not found')
  if (user.blockedAt || (await blocks.isBlockedEmail(customer?.email))) throw new ForbiddenError('account is not available')
  const cart = await carts.findPopulated(cartId)
  if (!cart || cart.items.length === 0) throw new BadRequestError('cart is empty')
  if (cart.items.some((entry) => entry.product === null)) throw new BadRequestError('cart contains an unavailable product')
  const items = cart.items.map((entry) => ({
    product: entry.product._id,
    name: entry.product.name,
    price: entry.product.price,
    qty: entry.qty
  }))
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0)
  const [recentOrderCount, isDomainBlocked] = await Promise.all([
    orderStats.countRecentOrders(user._id, new Date(Date.now() - VELOCITY_WINDOW_MS)),
    blocks.isBlockedEmail(customer?.email)
  ])
  const signals = evaluateSignals({ user, cart: { items }, customer, stats: { recentOrderCount, isDomainBlocked } })
  const fraud = scoreSignals(signals)
  if (fraud.decision === 'deny') throw new ForbiddenError('order could not be completed')
  const order = await orders.create({ user: user._id, items, total, customer, status: fraud.decision === 'review' ? 'review' : 'pending', fraud })
  cart.items = []
  await carts.save(cart)
  return order
}

export async function get(id) {
  if (!ObjectId.isValid(id)) throw new BadRequestError('invalid order id')
  const order = await orders.findById(id)
  if (!order) throw new NotFoundError('order not found')
  return order
}
