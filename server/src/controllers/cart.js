import * as cart from '../services/cart.js'

export async function view(req, res) {
  res.json(await cart.view(req.params.cartId))
}

export async function addItem(req, res) {
  res.json(await cart.addItem(req.params.cartId, req.body.productId, req.body.qty))
}

export async function changeQty(req, res) {
  res.json(await cart.changeQty(req.params.cartId, req.params.pid, req.body.qty))
}

export async function removeItem(req, res) {
  res.json(await cart.removeItem(req.params.cartId, req.params.pid))
}
