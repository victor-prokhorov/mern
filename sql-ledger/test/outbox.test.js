import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import http from 'node:http'
import app from '../src/app.js'
import { pool } from '../src/db.js'
import * as outboxRepo from '../src/repositories/outbox.js'
import { relayOnce, deliver, backoffMs } from '../src/outbox/relay.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

function startFakeUpstream(handler) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      handler(req, res, body)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

function stopFakeUpstream(server) {
  return new Promise((resolve) => server.close(resolve))
}

async function createAccount(overrides = {}) {
  const res = await request.execute(app).post('/api/accounts').send({ name: 'acc', currency: 'USD', ...overrides })
  return res.body
}

async function makeTransfer(fromAccountId, toAccountId, reference) {
  const res = await request.execute(app).post('/api/transfers').send({ reference, fromAccountId, toAccountId, amountMinor: 100 })
  if (res.status !== 201) throw new Error(`makeTransfer(${reference}) got ${res.status}: ${JSON.stringify(res.body)}`)
  return res.body
}

describe('transactional outbox', () => {
  useTestDb()

  it('leaves exactly one unpublished outbox row for a committed transfer', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })

    const transfer = await makeTransfer(alice.id, bob.id, 'ob-1')

    const rows = await outboxRepo.findByAggregate(pool, 'transfer', transfer.id)
    expect(rows).to.have.length(1)
    expect(rows[0].published_at).to.equal(null)
  })

  it('leaves no outbox row for a rolled-back transfer', async () => {
    const alice = await createAccount({ name: 'alice' })

    await request.execute(app).post('/api/transfers').send({ reference: 'ob-2', fromAccountId: alice.id, toAccountId: alice.id + 999999, amountMinor: 100 })

    const { rows } = await pool.query('SELECT * FROM outbox')
    expect(rows).to.have.length(0)
  })

  it('delivers and marks published, and a second relay run delivers nothing more', async () => {
    const received = []
    const { server, url } = await startFakeUpstream((req, res, body) => {
      received.push(body)
      res.writeHead(200)
      res.end()
    })
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    await makeTransfer(alice.id, bob.id, 'ob-3')

    const firstRunCount = await relayOnce({ pool, targetUrl: url, batchSize: 10, maxAttempts: 5 })
    const secondRunCount = await relayOnce({ pool, targetUrl: url, batchSize: 10, maxAttempts: 5 })

    expect(firstRunCount).to.equal(1)
    expect(secondRunCount).to.equal(0)
    expect(received).to.have.length(1)
    await stopFakeUpstream(server)
  })

  it('increments attempts and records the error when the upstream fails, leaving the row unpublished', async () => {
    const { server, url } = await startFakeUpstream((req, res) => {
      res.writeHead(500)
      res.end()
    })
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    const transfer = await makeTransfer(alice.id, bob.id, 'ob-4')

    await relayOnce({ pool, targetUrl: url, batchSize: 10, maxAttempts: 5 })

    const rows = await outboxRepo.findByAggregate(pool, 'transfer', transfer.id)
    expect(rows[0].published_at).to.equal(null)
    expect(rows[0].attempts).to.equal(1)
    expect(rows[0].last_error).to.include('500')
    await stopFakeUpstream(server)
  })

  it('grows the backoff delay with attempts and keeps it jittered within bounds', () => {
    const low = backoffMs(0, { base: 100, cap: 30000, random: () => 0 })
    const highAtZero = backoffMs(0, { base: 100, cap: 30000, random: () => 1 })
    const highAtFive = backoffMs(5, { base: 100, cap: 30000, random: () => 1 })

    expect(low).to.equal(0)
    expect(highAtZero).to.equal(100)
    expect(highAtFive).to.equal(3200)
    expect(highAtFive).to.be.greaterThan(highAtZero)
  })

  it('dead-letters a row after maxAttempts and still delivers a later healthy row', async () => {
    let fail = true
    const received = []
    const { server, url } = await startFakeUpstream((req, res, body) => {
      if (fail) {
        res.writeHead(500)
        res.end()
        return
      }
      received.push(body)
      res.writeHead(200)
      res.end()
    })
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    const badTransfer = await makeTransfer(alice.id, bob.id, 'ob-5')

    await relayOnce({ pool, targetUrl: url, batchSize: 10, maxAttempts: 1 })
    fail = false
    const goodTransfer = await makeTransfer(alice.id, bob.id, 'ob-6')
    await relayOnce({ pool, targetUrl: url, batchSize: 10, maxAttempts: 1 })

    const badRows = await outboxRepo.findByAggregate(pool, 'transfer', badTransfer.id)
    const goodRows = await outboxRepo.findByAggregate(pool, 'transfer', goodTransfer.id)
    expect(badRows[0].dead_lettered_at).to.not.equal(null)
    expect(badRows[0].published_at).to.equal(null)
    expect(goodRows[0].published_at).to.not.equal(null)
    await stopFakeUpstream(server)
  })

  it('never delivers the same row twice when two relay workers claim concurrently', async () => {
    const receivedIds = []
    const { server, url } = await startFakeUpstream((req, res, body) => {
      receivedIds.push(body.id)
      res.writeHead(200)
      res.end()
    })
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    for (let i = 0; i < 6; i += 1) await makeTransfer(alice.id, bob.id, `ob-conc-${i}`)

    await Promise.all([
      relayOnce({ pool, targetUrl: url, batchSize: 3, maxAttempts: 5 }),
      relayOnce({ pool, targetUrl: url, batchSize: 3, maxAttempts: 5 })
    ])

    const counts = receivedIds.reduce((acc, id) => acc.set(id, (acc.get(id) || 0) + 1), new Map())
    expect(receivedIds).to.have.length(6)
    expect([...counts.values()].every((count) => count === 1)).to.equal(true)
    await stopFakeUpstream(server)
  })

  it('delivers a row twice when the relay crashes between delivery and marking it published', async () => {
    const receivedIds = []
    const { server, url } = await startFakeUpstream((req, res, body) => {
      receivedIds.push(body.id)
      res.writeHead(200)
      res.end()
    })
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    await makeTransfer(alice.id, bob.id, 'ob-crash')

    const client = await pool.connect()
    let claimed
    try {
      await client.query('BEGIN')
      ;[claimed] = await outboxRepo.claimUnpublished(client, { batchSize: 1, maxAttempts: 5 })
      await deliver(claimed, url)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    await relayOnce({ pool, targetUrl: url, batchSize: 10, maxAttempts: 5 })

    const duplicates = receivedIds.filter((id) => id === claimed.id)
    expect(duplicates).to.have.length(2)
    await stopFakeUpstream(server)
  })
})
