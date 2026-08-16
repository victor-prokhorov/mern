import * as jobsRepo from '../repositories/jobs.js'
import { getDeadHandler } from './handlers.js'
import { backoffMs } from './backoff.js'

export async function enqueue(pool, { kind, payload, runAt, priority, maxAttempts }) {
  return jobsRepo.enqueue(pool, { kind, payload, runAt, priority, maxAttempts })
}

export async function claimJobs(pool, { workerId, kinds = null, limit = 1, leaseMs = 10000, perAccountLimit = null }) {
  return jobsRepo.claimJobs(pool, { workerId, kinds, limit, leaseMs, perAccountLimit })
}

export async function reapExpired(pool, options) {
  const reaped = await jobsRepo.reapExpired(pool, options)
  for (const job of reaped) {
    if (job.status !== 'dead') continue
    const onDead = getDeadHandler(job.kind)
    if (onDead) await onDead(job)
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

export async function failJob(pool, { jobId, workerId, lockedAt, attempts, maxAttempts, error, random }) {
  const nextAttempts = attempts + 1
  const dead = nextAttempts >= maxAttempts
  const message = error instanceof Error ? error.message : String(error)
  const delayMs = dead ? 0 : backoffMs(attempts, { random })
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
