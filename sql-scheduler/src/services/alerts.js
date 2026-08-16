import { pool } from '../db.js'
import * as alertsRepo from '../repositories/alerts.js'
import { NotFoundError, BadRequestError } from '../middleware/error.js'

export async function listAlerts() {
  return alertsRepo.list(pool)
}

export async function resolveAlert(id) {
  if (!Number.isSafeInteger(id)) throw new BadRequestError('id must be an integer')
  const resolved = await alertsRepo.resolveManually(pool, id)
  if (!resolved) throw new NotFoundError('alert not found or already resolved')
  return resolved
}
