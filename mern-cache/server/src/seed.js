import 'dotenv/config'
import mongoose from 'mongoose'
import { connect } from './db.js'
import * as productsRepo from './repositories/products.js'

export const products = [
  { sku: 'SKU-1', name: 'Aeron Chair', priceCents: 149900, stock: 12 },
  { sku: 'SKU-2', name: 'Standing Desk', priceCents: 89900, stock: 7 },
  { sku: 'SKU-3', name: 'Desk Lamp', priceCents: 4900, stock: 40 },
  { sku: 'SKU-4', name: 'Monitor Arm', priceCents: 12900, stock: 25 },
  { sku: 'SKU-5', name: 'Mechanical Keyboard', priceCents: 15900, stock: 18 }
]

export async function seedProducts() {
  await productsRepo.deleteAll()
  return productsRepo.insertMany(products)
}

if (process.env.NODE_ENV !== 'test') {
  await connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-cache')
  const created = await seedProducts()
  await mongoose.disconnect()
  console.log(`seeded ${created.length} products`)
}
