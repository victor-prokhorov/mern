import { pool } from '../db.js'
import * as accountsRepo from '../repositories/accounts.js'
import { BadRequestError } from '../middleware/error.js'

export async function createAccount({ name, timezone }) {
  if (!name || typeof name !== 'string') throw new BadRequestError('name is required')
  if (!timezone || typeof timezone !== 'string') throw new BadRequestError('timezone is required')
  return accountsRepo.create(pool, { name, timezone })
}

export async function listAccounts() {
  return accountsRepo.list(pool)
}
