import { pool } from '../db.js'
import * as queue from '../queue/service.js'
import { NotFoundError } from '../middleware/error.js'

export async function listJobs({ status, kind, limit, offset }) {
  return queue.listJobs(pool, { status: status || null, kind: kind || null, limit: limit || 50, offset: offset || 0 })
}

export async function retryDeadJob({ jobId }) {
  const job = await queue.retryDead(pool, jobId)
  if (!job) throw new NotFoundError('dead job not found')
  return job
}
