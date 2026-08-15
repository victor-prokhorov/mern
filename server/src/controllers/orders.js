import * as orders from '../services/orders.js'

export async function place(req, res) {
  const order = await orders.place(req.body)
  res.status(201).json(order)
}

export async function get(req, res) {
  res.json(await orders.get(req.params.id))
}
