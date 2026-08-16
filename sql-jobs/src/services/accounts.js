import { pool } from '../db.js'
import * as accountsRepo from '../repositories/accounts.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export async function createAccount({ name }) {
  if (!name || typeof name !== 'string') throw new BadRequestError('name is required')
  return accountsRepo.create(pool, { name })
}

export async function getAccount({ accountId }) {
  const account = await accountsRepo.findById(pool, accountId)
  if (!account) throw new NotFoundError('account not found')
  return account
}
