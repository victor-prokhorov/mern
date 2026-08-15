import Order from '../models/order.js'

export function create(doc) {
  return Order.create(doc)
}

export function findById(id) {
  return Order.findById(id)
}
