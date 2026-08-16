import { expect } from 'chai'
import pg from 'pg'
import { pool } from '../src/db.js'
import * as jobsRepo from '../src/repositories/jobs.js'
import * as queue from '../src/queue/service.js'
import { createWorker } from '../src/queue/worker.js'
import { registerHandler, clearHandlers } from '../src/queue/handlers.js'
import { useTestDb } from './helpers.js'

const { Pool } = pg

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('queue', () => {
  useTestDb()

  afterEach(() => {
    clearHandlers()
  })

  describe('claiming', () => {
    it('a claim never locks more of the ready pool than it actually takes, so a second claim run right after still gets its full share', async () => {
      for (let i = 0; i < 20; i++) await jobsRepo.enqueue(pool, { kind: 'noop', payload: {} })
      const holder = new Pool({ connectionString: process.env.DATABASE_URL })
      const client = await holder.connect()
      await client.query('BEGIN')

      const held = await jobsRepo.claimJobs(client, { workerId: 'a', limit: 10, leaseMs: 5000 })
      const secondBatch = await jobsRepo.claimJobs(pool, { workerId: 'b', limit: 10, leaseMs: 5000 })

      await client.query('ROLLBACK')
      client.release()
      await holder.end()
      const idsHeld = held.map((j) => j.id)
      const idsSecond = secondBatch.map((j) => j.id)
      expect(held.length).to.equal(10)
      expect(secondBatch.length).to.equal(10)
      expect(idsHeld.some((id) => idsSecond.includes(id))).to.equal(false)
    })

    it('SKIP LOCKED lets a second claim return other rows promptly while one row is held open in an uncommitted transaction', async () => {
      await jobsRepo.enqueue(pool, { kind: 'noop', payload: {} })
      await jobsRepo.enqueue(pool, { kind: 'noop', payload: {} })
      const holder = new Pool({ connectionString: process.env.DATABASE_URL })
      const client = await holder.connect()
      await client.query('BEGIN')
      await client.query("SELECT id FROM jobs WHERE status = 'ready' ORDER BY id LIMIT 1 FOR UPDATE")

      const start = Date.now()
      const claimed = await jobsRepo.claimJobs(pool, { workerId: 'b', limit: 10, leaseMs: 5000 })
      const elapsedMs = Date.now() - start

      await client.query('ROLLBACK')
      client.release()
      await holder.end()
      expect(claimed.length).to.equal(1)
      expect(elapsedMs).to.be.lessThan(500)
    })
  })

  describe('the fence', () => {
    it('a job whose lease expires is reclaimed by the same worker id at a later epoch, and the stale claims completeJob is a no-op', async () => {
      const job = await jobsRepo.enqueue(pool, { kind: 'noop', payload: {} })
      const [staleClaim] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 1 })
      await sleep(20)

      const reaped = await queue.reapExpired(pool, { random: () => 0 })
      const [reclaimed] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 5000 })
      const staleCompleteOk = await jobsRepo.completeJob(pool, {
        jobId: staleClaim.id,
        workerId: 'w',
        lockedAt: staleClaim.locked_at
      })

      expect(reaped.map((r) => r.id)).to.deep.equal([job.id])
      expect(reclaimed.id).to.equal(job.id)
      expect(reclaimed.locked_at.getTime()).to.not.equal(staleClaim.locked_at.getTime())
      expect(staleCompleteOk).to.equal(false)
      const current = await jobsRepo.findById(pool, job.id)
      expect(current.status).to.equal('running')
    })

    it('the reclaiming epochs completeJob after a reclaim does succeed', async () => {
      await jobsRepo.enqueue(pool, { kind: 'noop', payload: {} })
      const [staleClaim] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 1 })
      await sleep(20)
      await queue.reapExpired(pool, { random: () => 0 })
      const [reclaimed] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 5000 })

      const ok = await jobsRepo.completeJob(pool, { jobId: reclaimed.id, workerId: 'w', lockedAt: reclaimed.locked_at })

      expect(ok).to.equal(true)
      const current = await jobsRepo.findById(pool, staleClaim.id)
      expect(current.status).to.equal('done')
    })
  })

  describe('reaping', () => {
    it('preserves a real prior last_error instead of discarding it for "lease expired"', async () => {
      const job = await jobsRepo.enqueue(pool, { kind: 'noop', payload: {}, maxAttempts: 5 })
      const [claim1] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 5000 })
      await queue.failJob(pool, { jobId: claim1.id, workerId: 'w', lockedAt: claim1.locked_at, attempts: claim1.attempts, maxAttempts: claim1.max_attempts, error: 'upstream responded 500', random: () => 0 })
      await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 1 })
      await sleep(20)

      const reaped = await queue.reapExpired(pool)

      expect(reaped.map((r) => r.id)).to.deep.equal([job.id])
      const current = await jobsRepo.findById(pool, job.id)
      expect(current.last_error).to.include('upstream responded 500')
      expect(current.last_error).to.include('lease expired')
    })

    it('reschedules a reaped job with the same full-jitter backoff as a normal failure instead of making it instantly re-claimable', async () => {
      const job = await jobsRepo.enqueue(pool, { kind: 'noop', payload: {} })
      await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 1 })
      await sleep(20)

      const reaped = await queue.reapExpired(pool, { random: () => 1 })
      const claimed = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 5000 })

      expect(reaped.map((r) => r.id)).to.deep.equal([job.id])
      expect(claimed).to.deep.equal([])
      const { rows } = await pool.query('SELECT run_at > now() AS deferred FROM jobs WHERE id = $1', [job.id])
      expect(rows[0].deferred).to.equal(true)
    })
  })

  describe('heartbeat', () => {
    it('a stale epochs heartbeat does not extend the lease of a reclaimed job', async () => {
      await jobsRepo.enqueue(pool, { kind: 'noop', payload: {} })
      const [staleClaim] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 1 })
      await sleep(20)
      await queue.reapExpired(pool, { random: () => 0 })
      const [reclaimed] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 30 })

      const extended = await jobsRepo.heartbeat(pool, { jobId: reclaimed.id, workerId: 'w', lockedAt: staleClaim.locked_at, leaseMs: 5000 })
      await sleep(60)
      const reaped = await queue.reapExpired(pool)

      expect(extended).to.equal(null)
      expect(reaped.map((r) => r.id)).to.deep.equal([reclaimed.id])
    })

    it('a heartbeat prevents reaping', async () => {
      await jobsRepo.enqueue(pool, { kind: 'noop', payload: {} })
      const [claimed] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 30 })

      await sleep(15)
      await jobsRepo.heartbeat(pool, { jobId: claimed.id, workerId: 'w', lockedAt: claimed.locked_at, leaseMs: 5000 })
      await sleep(30)
      const reaped = await queue.reapExpired(pool)

      expect(reaped).to.deep.equal([])
      const current = await jobsRepo.findById(pool, claimed.id)
      expect(current.status).to.equal('running')
    })
  })

  describe('backoff', () => {
    it('grows with attempts and stays within the full-jitter bounds rather than being an exact value', async () => {
      const { backoffMs } = await import('../src/queue/backoff.js')

      const low = backoffMs(0, { base: 100, cap: 30000, random: () => 1 })
      const high = backoffMs(5, { base: 100, cap: 30000, random: () => 1 })
      const zero = backoffMs(5, { base: 100, cap: 30000, random: () => 0 })

      expect(high).to.be.greaterThan(low)
      expect(zero).to.equal(0)
      expect(high).to.be.at.most(30000)
    })
  })

  describe('dead-lettering', () => {
    it('a job exceeding max_attempts goes dead, and a later healthy job still runs', async () => {
      const doomed = await jobsRepo.enqueue(pool, { kind: 'noop', payload: {}, maxAttempts: 2 })
      const [claim1] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 5000 })
      await queue.failJob(pool, { jobId: claim1.id, workerId: 'w', lockedAt: claim1.locked_at, attempts: claim1.attempts, maxAttempts: claim1.max_attempts, error: 'boom', random: () => 0 })
      const [claim2] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 5000 })

      await queue.failJob(pool, { jobId: claim2.id, workerId: 'w', lockedAt: claim2.locked_at, attempts: claim2.attempts, maxAttempts: claim2.max_attempts, error: 'boom again', random: () => 0 })
      const healthy = await jobsRepo.enqueue(pool, { kind: 'noop', payload: {} })
      const [claim3] = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 5000 })

      const doomedRow = await jobsRepo.findById(pool, doomed.id)
      expect(doomedRow.status).to.equal('dead')
      expect(claim3.id).to.equal(healthy.id)
    })
  })

  describe('idempotent handlers', () => {
    it('running the same job twice publishes once', async () => {
      const { deliverMessage } = await import('../src/services/messages.js')
      const { pool: appPool } = await import('../src/db.js')
      const http = await import('node:http')
      let deliveries = 0
      const server = http.createServer((_req, res) => {
        deliveries += 1
        res.writeHead(200)
        res.end()
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const accountRow = await appPool.query("INSERT INTO accounts (name) VALUES ('a') RETURNING id")
      const accountId = accountRow.rows[0].id
      const messageRow = await appPool.query(
        "INSERT INTO messages (account_id, recipient, body) VALUES ($1, 'r', 'b') RETURNING id",
        [accountId]
      )
      const messageId = messageRow.rows[0].id
      const job = { payload: { messageId, recipient: 'r', body: 'b', upstreamUrl: `http://127.0.0.1:${port}/deliver` } }

      const first = await deliverMessage(job)
      const second = await deliverMessage(job)

      server.close()
      expect(deliveries).to.equal(1)
      expect(first).to.equal(true)
      expect(second).to.equal(false)
      const { rows } = await appPool.query('SELECT status FROM messages WHERE id = $1', [messageId])
      expect(rows[0].status).to.equal('sent')
    })
  })

  describe('permanent delivery failure', () => {
    it('a delivery that fails on its final attempt marks the message failed, not stuck sending forever', async () => {
      const { deliverMessage } = await import('../src/services/messages.js')
      const { pool: appPool } = await import('../src/db.js')
      const http = await import('node:http')
      const server = http.createServer((_req, res) => {
        res.writeHead(500)
        res.end()
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const accountRow = await appPool.query("INSERT INTO accounts (name) VALUES ('a') RETURNING id")
      const accountId = accountRow.rows[0].id
      const messageRow = await appPool.query(
        "INSERT INTO messages (account_id, recipient, body) VALUES ($1, 'r', 'b') RETURNING id",
        [accountId]
      )
      const messageId = messageRow.rows[0].id
      const job = {
        attempts: 4,
        max_attempts: 5,
        payload: { messageId, recipient: 'r', body: 'b', upstreamUrl: `http://127.0.0.1:${port}/deliver` }
      }

      let threw = false
      try {
        await deliverMessage(job)
      } catch (err) {
        threw = true
      }

      server.close()
      expect(threw).to.equal(true)
      const { rows } = await appPool.query('SELECT status FROM messages WHERE id = $1', [messageId])
      expect(rows[0].status).to.equal('failed')
    })

    it('a delivery that fails with retries left leaves the message sending, not failed', async () => {
      const { deliverMessage } = await import('../src/services/messages.js')
      const { pool: appPool } = await import('../src/db.js')
      const http = await import('node:http')
      const server = http.createServer((_req, res) => {
        res.writeHead(500)
        res.end()
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address()
      const accountRow = await appPool.query("INSERT INTO accounts (name) VALUES ('a') RETURNING id")
      const accountId = accountRow.rows[0].id
      const messageRow = await appPool.query(
        "INSERT INTO messages (account_id, recipient, body) VALUES ($1, 'r', 'b') RETURNING id",
        [accountId]
      )
      const messageId = messageRow.rows[0].id
      const job = {
        attempts: 0,
        max_attempts: 5,
        payload: { messageId, recipient: 'r', body: 'b', upstreamUrl: `http://127.0.0.1:${port}/deliver` }
      }

      let threw = false
      try {
        await deliverMessage(job)
      } catch (err) {
        threw = true
      }

      server.close()
      expect(threw).to.equal(true)
      const { rows } = await appPool.query('SELECT status FROM messages WHERE id = $1', [messageId])
      expect(rows[0].status).to.equal('sending')
    })

    it('a job dead-lettered by the reaper on its final attempt marks the message failed, not stuck sending forever', async () => {
      const messagesService = await import('../src/services/messages.js')
      const messagesRepo = await import('../src/repositories/messages.js')
      registerHandler('send_message', messagesService.deliverMessage, { onDead: messagesService.markDeliveryFailed })
      const accountRow = await pool.query("INSERT INTO accounts (name) VALUES ('a') RETURNING id")
      const accountId = accountRow.rows[0].id
      const messageRow = await pool.query(
        "INSERT INTO messages (account_id, recipient, body) VALUES ($1, 'r', 'b') RETURNING id",
        [accountId]
      )
      const messageId = messageRow.rows[0].id
      await jobsRepo.enqueue(pool, { kind: 'send_message', payload: { messageId }, maxAttempts: 1 })
      await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 1, leaseMs: 1 })
      await messagesRepo.beginSending(pool, messageId)
      await sleep(20)

      const reaped = await queue.reapExpired(pool)

      expect(reaped.map((r) => r.status)).to.deep.equal(['dead'])
      const { rows } = await pool.query('SELECT status FROM messages WHERE id = $1', [messageId])
      expect(rows[0].status).to.equal('failed')
    })
  })

  describe('fairness', () => {
    it('one accounts backlog does not starve another accounts job', async () => {
      for (let i = 0; i < 10; i++) await jobsRepo.enqueue(pool, { kind: 'send_message', payload: { accountId: '1' } })
      await jobsRepo.enqueue(pool, { kind: 'send_message', payload: { accountId: '2' } })

      const claimed = await jobsRepo.claimJobs(pool, { workerId: 'w', limit: 3, leaseMs: 5000, perAccountLimit: 2 })

      const forAccount1 = claimed.filter((j) => j.payload.accountId === '1')
      const forAccount2 = claimed.filter((j) => j.payload.accountId === '2')
      expect(forAccount1.length).to.be.at.most(2)
      expect(forAccount2.length).to.equal(1)
    })

    it('the worker applies the fairness cap through its own claim loop, the same path index.js wires WORKER_PER_ACCOUNT_LIMIT into', async () => {
      registerHandler('send_message', () => sleep(200))
      for (let i = 0; i < 10; i++) await jobsRepo.enqueue(pool, { kind: 'send_message', payload: { accountId: '1' } })
      await jobsRepo.enqueue(pool, { kind: 'send_message', payload: { accountId: '2' } })
      const worker = createWorker({ pool, workerId: 'w', concurrency: 3, pollMs: 20, leaseMs: 5000, perAccountLimit: 2 })

      await worker.tick()
      const running = await pool.query("SELECT payload FROM jobs WHERE status = 'running'")

      await worker.stop({ timeoutMs: 500 })
      const forAccount1 = running.rows.filter((r) => r.payload.accountId === '1')
      const forAccount2 = running.rows.filter((r) => r.payload.accountId === '2')
      expect(forAccount1.length).to.be.at.most(2)
      expect(forAccount2.length).to.equal(1)
    })
  })

  describe('graceful shutdown', () => {
    it('releases the lease of an in-flight job rather than leaving it locked until the reaper', async () => {
      registerHandler('slow', () => sleep(200))
      const job = await jobsRepo.enqueue(pool, { kind: 'slow', payload: {} })
      const worker = createWorker({ pool, workerId: 'w', concurrency: 1, pollMs: 20, leaseMs: 5000 })
      worker.start()
      await sleep(40)

      await worker.stop({ timeoutMs: 50 })

      const current = await jobsRepo.findById(pool, job.id)
      expect(current.status).to.equal('ready')
      expect(current.locked_by).to.equal(null)
    })
  })
})
