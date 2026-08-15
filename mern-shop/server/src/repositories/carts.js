import Cart from '../models/cart.js'

export function loadOrCreate(cartId) {
  return Cart.findOneAndUpdate({ cartId }, { $setOnInsert: { items: [] } }, { upsert: true, returnDocument: 'after' })
}

export function findPopulated(cartId) {
  return Cart.findOne({ cartId }).populate('items.product')
}

export function populate(cart) {
  return cart.populate('items.product')
}

export function save(cart) {
  return cart.save()
}
