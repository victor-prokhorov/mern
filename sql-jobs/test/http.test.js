import { expect } from 'chai'
import { pool } from '../src/db.js'
import * as jobsRepo from '../src/repositories/jobs.js'
import { httpAgent, useTestDb, createAccount } from './helpers.js'

describe('http surface', () => {
  useTestDb()

  it('creates an account', async () => {
    const res = await httpAgent.post('/api/accounts').send({ name: 'Acme Inc' })

    expect(res.status).to.equal(201)
    expect(res.body.name).to.equal('Acme Inc')
  })

  it('creating a message enqueues a send_message job for it', async () => {
    const account = await createAccount({ name: 'Acme Inc' })

    const res = await httpAgent.post('/api/messages').send({ accountId: account.id, recipient: 'a@b.test', body: 'hi' })

    expect(res.status).to.equal(201)
    const jobsRes = await httpAgent.get('/api/jobs').query({ kind: 'send_message', status: 'ready' })
    expect(jobsRes.body.length).to.equal(1)
    expect(jobsRes.body[0].payload.messageId).to.equal(res.body.id)
  })

  it('lists jobs filtered by status, and surfaces the dead-letter queue', async () => {
    await jobsRepo.enqueue(pool, { kind: 'noop', payload: {} })
    const doomed = await jobsRepo.enqueue(pool, { kind: 'always_fails', payload: {}, maxAttempts: 1 })
    const [claimed] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 5000, kinds: ['always_fails'] })
    await jobsRepo.failJob(pool, { jobId: claimed.id, workerId: 'w', lockedAt: claimed.locked_at, error: 'boom', delayMs: 0, dead: true })

    const deadRes = await httpAgent.get('/api/jobs').query({ status: 'dead' })

    expect(deadRes.body.map((j) => j.id)).to.deep.equal([String(doomed.id)])
  })

  it('retrying a dead job resets it to ready so a worker can pick it up again', async () => {
    const doomed = await jobsRepo.enqueue(pool, { kind: 'noop', payload: {}, maxAttempts: 1 })
    const [claimed] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 5000 })
    await jobsRepo.failJob(pool, { jobId: claimed.id, workerId: 'w', lockedAt: claimed.locked_at, error: 'boom', delayMs: 0, dead: true })

    const res = await httpAgent.post(`/api/jobs/${doomed.id}/retry`)

    expect(res.status).to.equal(200)
    expect(res.body.status).to.equal('ready')
    const current = await jobsRepo.findById(pool, doomed.id)
    expect(current.status).to.equal('ready')
    expect(current.attempts).to.equal(0)
  })

  it('retrying a job that is not dead is rejected', async () => {
    const job = await jobsRepo.enqueue(pool, { kind: 'noop', payload: {} })

    const res = await httpAgent.post(`/api/jobs/${job.id}/retry`)

    expect(res.status).to.equal(404)
  })
})
