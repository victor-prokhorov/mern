import * as inventoryRepo from '../repositories/inventory.js'
import * as paymentsRepo from '../repositories/payments.js'
import * as ordersRepo from '../repositories/orders.js'
import * as shipmentsRepo from '../repositories/shipments.js'

export const orderSteps = new Map([
  [
    'reserve_inventory',
    {
      action: async ({ pool, sagaId, context }) => {
        await inventoryRepo.reserve(pool, { sagaId, sku: context.sku, qty: context.qty })
      },
      compensate: async ({ pool, sagaId, context }) => {
        await inventoryRepo.release(pool, { sagaId, sku: context.sku })
      }
    }
  ],
  [
    'charge_payment',
    {
      action: async ({ pool, sagaId, context }) => {
        await paymentsRepo.charge(pool, { sagaId, amountMinor: context.amountMinor })
      },
      compensate: async ({ pool, sagaId }) => {
        await paymentsRepo.refund(pool, sagaId)
      }
    }
  ],
  [
    'commit_order',
    {
      action: async ({ pool, context }) => {
        const placed = await ordersRepo.place(pool, context.orderId)
        if (!placed) throw new Error(`order ${context.orderId} could not be placed`)
      }
    }
  ],
  [
    'confirm_shipping',
    {
      action: async ({ pool, sagaId, context }) => {
        await shipmentsRepo.schedule(pool, { sagaId, address: context.address })
      }
    }
  ]
])
