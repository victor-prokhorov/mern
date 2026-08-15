import { pool } from '../db.js'
import * as accountsRepo from '../repositories/accounts.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

export async function createAccount({ name, currency }) {
  if (!name || typeof name !== 'string') throw new BadRequestError('name is required')
  if (!currency || typeof currency !== 'string' || currency.length !== 3) throw new BadRequestError('currency must be a 3-letter code')
  return accountsRepo.create(pool, { name, currency })
}

export async function getBalance({ accountId }) {
  const account = await accountsRepo.findById(pool, accountId)
  if (!account) throw new NotFoundError('account not found')
  const balanceMinor = await accountsRepo.computeDerivedBalance(pool, accountId)
  return { accountId: account.id, balanceMinor: balanceMinor.toString() }
}
