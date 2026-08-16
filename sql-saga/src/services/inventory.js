import { pool } from '../db.js'
import * as inventoryRepo from '../repositories/inventory.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export async function upsertItem({ sku, available }) {
  if (!sku || typeof sku !== 'string') throw new BadRequestError('sku is required')
  if (!Number.isInteger(available) || available < 0) throw new BadRequestError('available must be a non-negative integer')
  return inventoryRepo.upsertItem(pool, { sku, available })
}

export async function getItem({ sku }) {
  const item = await inventoryRepo.findBySku(pool, sku)
  if (!item) throw new NotFoundError('sku not found')
  return item
}
