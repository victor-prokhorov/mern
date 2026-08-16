import { pool } from '../db.js'
import * as schedulesRepo from '../repositories/schedules.js'
import * as accountsRepo from '../repositories/accounts.js'
import { parseCadence, nextOccurrence } from '../cadence/index.js'
import { BadRequestError } from '../middleware/error.js'

const VALID_CATCHUP_POLICIES = new Set(['skip', 'all', 'none'])

export async function createSchedule({ accountId, name, cadence, timezone, catchupPolicy = 'skip' }) {
  if (!Number.isSafeInteger(accountId)) throw new BadRequestError('accountId must be an integer')
  if (!name || typeof name !== 'string') throw new BadRequestError('name is required')
  if (!timezone || typeof timezone !== 'string') throw new BadRequestError('timezone is required')
  if (!VALID_CATCHUP_POLICIES.has(catchupPolicy)) throw new BadRequestError('catchupPolicy must be one of skip, all, none')
  try {
    parseCadence(cadence)
  } catch (err) {
    throw new BadRequestError(err.message)
  }
  const account = await accountsRepo.findById(pool, accountId)
  if (!account) throw new BadRequestError('account does not exist')
  const nextRunAt = nextOccurrence({ cadence, timezone, after: new Date() })
  return schedulesRepo.create(pool, { accountId, name, cadence, timezone, nextRunAt, catchupPolicy })
}

export async function listSchedules() {
  return schedulesRepo.list(pool)
}
