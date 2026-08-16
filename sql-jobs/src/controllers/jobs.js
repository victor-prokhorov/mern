import * as jobsService from '../services/jobs.js'

export async function listJobs(req, res) {
  const jobs = await jobsService.listJobs({
    status: req.query.status,
    kind: req.query.kind,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    offset: req.query.offset ? Number(req.query.offset) : undefined
  })
  res.status(200).json(jobs)
}

export async function retryDeadJob(req, res) {
  const job = await jobsService.retryDeadJob({ jobId: Number(req.params.id) })
  res.status(200).json(job)
}
