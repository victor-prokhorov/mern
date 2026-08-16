import * as jobsRepo from '../repositories/jobs.js'
import { getHandler } from './handlers.js'
import { completeJob, failJob } from './service.js'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createWorker({
  pool,
  workerId,
  kinds = null,
  concurrency = 1,
  pollMs = 500,
  leaseMs = 10000,
  perAccountLimit = null,
  onError = () => {}
}) {
  let timer = null
  let stopping = false
  let ticking = false
  const inFlight = new Map()

  async function runJob(job) {
    const claim = { workerId, lockedAt: job.locked_at }
    inFlight.set(job.id, claim)
    const hbTimer = setInterval(() => {
      jobsRepo.heartbeat(pool, { jobId: job.id, workerId, lockedAt: job.locked_at, leaseMs }).catch((err) => onError(err, job))
    }, Math.max(50, Math.floor(leaseMs / 3)))
    try {
      const handler = getHandler(job.kind)
      if (!handler) throw new Error(`no handler registered for kind "${job.kind}"`)
      await handler(job)
      await completeJob(pool, { jobId: job.id, workerId, lockedAt: job.locked_at })
    } catch (err) {
      await failJob(pool, { jobId: job.id, workerId, lockedAt: job.locked_at, error: err })
      onError(err, job)
    } finally {
      clearInterval(hbTimer)
      inFlight.delete(job.id)
    }
  }

  async function tick() {
    if (ticking || stopping) return
    ticking = true
    try {
      const room = concurrency - inFlight.size
      if (room <= 0) return
      const jobs = await jobsRepo.claimJobs(pool, { workerId, kinds, limit: room, leaseMs, perAccountLimit })
      for (const job of jobs) runJob(job).catch((err) => onError(err, job))
    } catch (err) {
      onError(err, null)
    } finally {
      ticking = false
    }
  }

  function start() {
    stopping = false
    timer = setInterval(tick, pollMs)
    tick()
  }

  async function stop({ timeoutMs = 2000 } = {}) {
    stopping = true
    if (timer) clearInterval(timer)
    const deadline = Date.now() + timeoutMs
    while (inFlight.size > 0 && Date.now() < deadline) {
      await sleep(25)
    }
    for (const [jobId, claim] of inFlight) {
      await jobsRepo.releaseLease(pool, { jobId, workerId: claim.workerId, lockedAt: claim.lockedAt })
    }
  }

  return { start, stop, tick, inFlightCount: () => inFlight.size }
}
