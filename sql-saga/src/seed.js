import 'dotenv/config'
import { pool } from './db.js'
import { migrate } from './migrations/runner.js'
import * as inventoryRepo from './repositories/inventory.js'
import { placeOrder } from './services/orders.js'

async function main() {
  await migrate(pool)
  await inventoryRepo.upsertItem(pool, { sku: 'WIDGET-1', available: 10 })
  await inventoryRepo.upsertItem(pool, { sku: 'WIDGET-SCARCE', available: 1 })
  const completed = await placeOrder({ sku: 'WIDGET-1', qty: 2, amountMinor: 4999, address: '1 Test Lane' })
  const aborted = await placeOrder({ sku: 'WIDGET-SCARCE', qty: 5, amountMinor: 9999, address: '2 Test Lane' })
  console.log('seeded', {
    completedSaga: { id: completed.saga.id, status: completed.saga.status },
    abortedSaga: { id: aborted.saga.id, status: aborted.saga.status }
  })
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
