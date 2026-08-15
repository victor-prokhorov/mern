import { pool, withTransaction } from '../db.js'
import * as transfersRepo from '../repositories/transfers.js'
import * as entriesRepo from '../repositories/entries.js'
import * as accountsRepo from '../repositories/accounts.js'
import { encodeCursor, decodeCursor } from '../pagination/cursor.js'
import { BadRequestError, ConflictError } from '../middleware/error.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

function clampLimit(rawLimit) {
  const parsed = Number(rawLimit)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

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

export async function listKeyset({ limit, cursor }) {
  const clampedLimit = clampLimit(limit)
  const decodedCursor = cursor ? decodeCursor(cursor) : null
  const rows = await transfersRepo.findPageKeyset(pool, { limit: clampedLimit + 1, cursor: decodedCursor })
  const hasMore = rows.length > clampedLimit
  const page = hasMore ? rows.slice(0, clampedLimit) : rows
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null
  return { transfers: page, nextCursor }
}

export async function listOffsetDemo({ limit, offset }) {
  const clampedLimit = clampLimit(limit)
  const parsedOffset = Number.isInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0
  const transfers = await transfersRepo.findPageOffsetDemo(pool, { limit: clampedLimit, offset: parsedOffset })
  return { transfers }
}
