import { pool } from '../db.js'
import * as runsRepo from '../repositories/runs.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

function clampLimit(rawLimit) {
  const parsed = Number(rawLimit)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

export async function listRunsWithLag({ limit } = {}) {
  return runsRepo.listWithLag(pool, { limit: clampLimit(limit) })
}
