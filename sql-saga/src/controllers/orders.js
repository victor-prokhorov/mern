import * as ordersService from '../services/orders.js'

export async function placeOrder(req, res) {
  const result = await ordersService.placeOrder(req.body)
  res.status(201).json(result)
}

export async function getSaga(req, res) {
  const result = await ordersService.getSaga({ sagaId: Number(req.params.id) })
  res.status(200).json(result)
}
