import { withTransaction } from '../db.js'
import * as transfersRepo from '../repositories/transfers.js'
import * as entriesRepo from '../repositories/entries.js'
import * as accountsRepo from '../repositories/accounts.js'
import { BadRequestError, ConflictError } from '../middleware/error.js'

function assertValidTransferInput({ reference, fromAccountId, toAccountId, amountMinor }) {
  if (!reference || typeof reference !== 'string') throw new BadRequestError('reference is required')
  if (!Number.isInteger(fromAccountId) || !Number.isInteger(toAccountId)) throw new BadRequestError('fromAccountId and toAccountId must be integers')
  if (fromAccountId === toAccountId) throw new BadRequestError('fromAccountId and toAccountId must differ')
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new BadRequestError('amountMinor must be a positive integer')
}

export async function createTransfer({ reference, fromAccountId, toAccountId, amountMinor }) {
  assertValidTransferInput({ reference, fromAccountId, toAccountId, amountMinor })
  try {
    return await withTransaction(async (client) => {
      const transfer = await transfersRepo.create(client, { reference, status: 'completed' })
      await entriesRepo.create(client, { transferId: transfer.id, accountId: fromAccountId, amountMinor: -amountMinor })
      await entriesRepo.create(client, { transferId: transfer.id, accountId: toAccountId, amountMinor })
      await accountsRepo.adjustBalance(client, fromAccountId, -amountMinor)
      await accountsRepo.adjustBalance(client, toAccountId, amountMinor)
      return transfer
    })
  } catch (err) {
    if (err.code === transfersRepo.UNIQUE_VIOLATION) throw new ConflictError('reference already used')
    if (err.code === transfersRepo.FOREIGN_KEY_VIOLATION) throw new BadRequestError('fromAccountId or toAccountId does not exist')
    throw err
  }
}
