import { pool, withTransaction } from '../db.js'
import * as ordersRepo from '../repositories/orders.js'
import * as inventoryRepo from '../repositories/inventory.js'
import * as sagaRepo from '../repositories/saga.js'
import * as paymentsRepo from '../repositories/payments.js'
import * as shipmentsRepo from '../repositories/shipments.js'
import { startSaga, runSaga } from '../saga/engine.js'
import { orderSteps } from '../saga/steps.js'
import { ORDER_FULFILLMENT } from '../saga/definitions.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export async function placeOrder({ sku, qty, amountMinor, address }, options = {}) {
  if (!sku || typeof sku !== 'string') throw new BadRequestError('sku is required')
  if (!Number.isInteger(qty) || qty <= 0) throw new BadRequestError('qty must be a positive integer')
  if (!Number.isInteger(amountMinor) || amountMinor < 0) throw new BadRequestError('amountMinor must be a non-negative integer')
  if (!address || typeof address !== 'string') throw new BadRequestError('address is required')
  const saga = await withTransaction(async (client) => {
    const item = await inventoryRepo.findBySku(client, sku)
    if (!item) throw new NotFoundError('sku not found')
    const order = await ordersRepo.create(client, { sku, qty, amountMinor, address })
    return startSaga(client, {
      type: 'order_fulfillment',
      orderId: order.id,
      context: { orderId: order.id, sku, qty, amountMinor, address },
      definition: ORDER_FULFILLMENT
    })
  })
  const result = await runSaga(pool, { sagaId: saga.id, registry: orderSteps, ...options })
  return getSaga({ sagaId: result.id })
}

export async function getSaga({ sagaId }) {
  const saga = await sagaRepo.findSaga(pool, sagaId)
  if (!saga) throw new NotFoundError('saga not found')
  const steps = await sagaRepo.listSteps(pool, sagaId)
  const payment = await paymentsRepo.findBySaga(pool, sagaId)
  const shipment = await shipmentsRepo.findBySaga(pool, sagaId)
  const order = saga.order_id ? await ordersRepo.findById(pool, saga.order_id) : null
  return { saga, steps, order, payment, shipment }
}
