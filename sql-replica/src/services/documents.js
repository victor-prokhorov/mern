import 'dotenv/config'
import { pool } from '../db.js'
import { systemClock } from '../replication/clock.js'
import { createEnv } from '../replication/topology.js'
import { createSession } from '../replication/session.js'
import { writeDocument as engineWrite, readDocument as engineRead } from '../replication/router.js'
import { tick as engineTick } from '../replication/tick.js'
import * as changesRepo from '../repositories/changes.js'
import * as replicaStateRepo from '../repositories/replicaState.js'
import { BadRequestError } from '../middleware/error.js'

function parseLags() {
  const raw = process.env.REPLICA_LAG_MS || '5000'
  return raw.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value))
}

const replicas = parseLags().map((lagMs, index) => ({ name: `replica-${index + 1}`, lagMs }))
const stickyMs = Number(process.env.STICKY_MS) || 5000
const env = createEnv({ clock: systemClock, replicas, stickyMs })
const sessions = new Map()

function sessionFor(sessionId) {
  if (!sessionId) return null
  if (!sessions.has(sessionId)) sessions.set(sessionId, createSession())
  return sessions.get(sessionId)
}

function assertWriteInput({ accountId, docKey, body }) {
  if (!Number.isSafeInteger(accountId)) throw new BadRequestError('accountId must be an integer')
  if (!docKey || typeof docKey !== 'string') throw new BadRequestError('docKey is required')
  if (typeof body !== 'string') throw new BadRequestError('body must be a string')
}

export async function writeDocument({ accountId, docKey, body, sessionId }) {
  assertWriteInput({ accountId, docKey, body })
  const session = sessionFor(sessionId)
  try {
    return await engineWrite(env, { accountId, docKey, body, session })
  } catch (err) {
    if (err.code === changesRepo.FOREIGN_KEY_VIOLATION) throw new BadRequestError('accountId does not exist')
    throw err
  }
}

export async function readDocument({ accountId, docKey, sessionId, consistency, token, sticky, pinned }) {
  if (!Number.isSafeInteger(accountId)) throw new BadRequestError('accountId must be an integer')
  if (!docKey || typeof docKey !== 'string') throw new BadRequestError('docKey is required')
  const session = sessionFor(sessionId)
  return engineRead(env, { accountId, docKey, session, consistency, token: token || null, sticky: Boolean(sticky), pinned: Boolean(pinned) })
}

export async function tick() {
  return engineTick(env)
}

export async function replicationState() {
  const primaryPosition = await changesRepo.primaryPosition(pool)
  const stateRows = await replicaStateRepo.list(pool)
  const replicaList = stateRows.map((row) => ({ name: row.replica_name, appliedThrough: Number(row.applied_through), appliedAt: row.applied_at }))
  return { primaryPosition, topology: env.topology.replicas, replicas: replicaList }
}
