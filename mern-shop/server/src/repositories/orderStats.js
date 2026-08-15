import Order from '../models/order.js'

export function countRecentOrders(userId, since) {
  return Order.countDocuments({ user: userId, createdAt: { $gte: since } })
}
