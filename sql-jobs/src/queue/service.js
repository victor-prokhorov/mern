import * as jobsRepo from '../repositories/jobs.js'
import { withTransaction } from '../db.js'
import { getDeadHandler } from './handlers.js'
import { backoffMs } from './backoff.js'

export async function enqueue(pool, { kind, payload, runAt, priority, maxAttempts }) {
  return jobsRepo.enqueue(pool, { kind, payload, runAt, priority, maxAttempts })
}

export async function claimJobs(pool, { workerId, kinds = null, limit = 1, leaseMs = 10000, perAccountLimit = null }) {
  return jobsRepo.claimJobs(pool, { workerId, kinds, limit, leaseMs, perAccountLimit })
}

export async function reapExpired(pool, options = {}) {
  const { limit, random } = options
  const reaped = await withTransaction(async (client) => {
    const expired = await jobsRepo.selectExpired(client, { limit })
    const rows = []
    for (const job of expired) {
      const dead = job.attempts + 1 >= job.max_attempts
      const delayMs = dead ? 0 : backoffMs(job.attempts, { random })
      rows.push(await jobsRepo.reapJob(client, { jobId: job.id, dead, delayMs }))
    }
    return rows
  })
  for (const job of reaped) {
    if (job.status !== 'dead') continue
    const onDead = getDeadHandler(job.kind)
    if (!onDead) continue
    try {
      await onDead(job)
    } catch (err) {
      console.error('onDead handler failed', job.id, err instanceof Error ? err.message : String(err))
    }
  }
  return reaped
}

export async function heartbeat(pool, { jobId, workerId, lockedAt, leaseMs = 10000 }) {
  const row = await jobsRepo.heartbeat(pool, { jobId, workerId, lockedAt, leaseMs })
  return row !== null
}

export async function completeJob(pool, { jobId, workerId, lockedAt }) {
  return jobsRepo.completeJob(pool, { jobId, workerId, lockedAt })
}

export async function failJob(pool, { jobId, workerId, lockedAt, error, random }) {
  const current = await jobsRepo.findClaimed(pool, { jobId, workerId, lockedAt })
  if (!current) return false
  const dead = current.attempts + 1 >= current.max_attempts
  const message = error instanceof Error ? error.message : String(error)
  const delayMs = dead ? 0 : backoffMs(current.attempts, { random })
  return jobsRepo.failJob(pool, { jobId, workerId, lockedAt, error: message, delayMs, dead })
}

export async function releaseLease(pool, { jobId, workerId, lockedAt }) {
  return jobsRepo.releaseLease(pool, { jobId, workerId, lockedAt })
}

export async function listJobs(pool, filters) {
  return jobsRepo.listJobs(pool, filters)
}

export async function retryDead(pool, id) {
  return jobsRepo.retryDead(pool, id)
}
