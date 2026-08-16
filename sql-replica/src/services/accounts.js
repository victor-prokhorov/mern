import { pool } from '../db.js'
import * as accountsRepo from '../repositories/accounts.js'
import { BadRequestError } from '../middleware/error.js'

export async function createAccount({ name }) {
  if (!name || typeof name !== 'string') throw new BadRequestError('name is required')
  return accountsRepo.create(pool, { name })
}

export async function listAccounts() {
  return accountsRepo.list(pool)
}
