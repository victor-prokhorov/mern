import { expect, use } from 'chai'
import chaiHttp from 'chai-http'
import http from 'node:http'
import { pool } from '../src/db.js'
import * as outboxRepo from '../src/repositories/outbox.js'
import * as transfersRepo from '../src/repositories/transfers.js'
import { relayOnce, deliver, backoffMs, claimBatch, createGuardedPoll } from '../src/outbox/relay.js'
import { useTestDb, createAccount, makeTransfer as makeTransferShared, httpAgent } from './helpers.js'

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

function makeTransfer(fromAccountId, toAccountId, reference) {
  return makeTransferShared(fromAccountId, toAccountId, 100, reference)
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

  it('writes the transfer and its outbox row in the same transaction, proven by matching xmin', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })

    const transfer = await makeTransfer(alice.id, bob.id, 'ob-xmin-1')

    const transferRow = await transfersRepo.findById(pool, transfer.id)
    const [outboxRow] = await outboxRepo.findByAggregate(pool, 'transfer', transfer.id)
    expect(outboxRow.xmin).to.be.a('string')
    expect(outboxRow.xmin).to.equal(transferRow.xmin)
  })

  it('leaves no outbox row for a rolled-back transfer, even though the outbox insert already ran earlier in that same (rolled-back) transaction', async () => {
    const alice = await createAccount({ name: 'alice' })

    const res = await httpAgent.post('/api/transfers').send({ reference: 'ob-2', fromAccountId: alice.id, toAccountId: alice.id + 999999, amountMinor: 100 })

    expect(res).to.have.status(400)
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

    const [claimed] = await claimBatch(pool, { batchSize: 1, maxAttempts: 5 })
    await deliver(claimed, url)
    await relayOnce({ pool, targetUrl: url, batchSize: 10, maxAttempts: 5 })

    const duplicates = receivedIds.filter((id) => id === claimed.id)
    expect(duplicates).to.have.length(2)
    await stopFakeUpstream(server)
  })

  it('does not block on a row locked by another transaction, unlike plain FOR UPDATE', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    const locked = await makeTransfer(alice.id, bob.id, 'lock-1')
    const free = await makeTransfer(alice.id, bob.id, 'lock-2')
    const holder = await pool.connect()
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM outbox WHERE aggregate_id = $1 FOR UPDATE', [locked.id])

    const startedAt = Date.now()
    const rows = await claimBatch(pool, { batchSize: 10, maxAttempts: 5 })
    const elapsedMs = Date.now() - startedAt

    await holder.query('ROLLBACK')
    holder.release()
    expect(elapsedMs).to.be.lessThan(1000)
    expect(rows.map((row) => row.aggregate_id)).to.not.include(locked.id)
    expect(rows.map((row) => row.aggregate_id)).to.include(free.id)
  })

  it('the poll guard skips an overlapping tick, so a slow upstream never gets the same row delivered twice', async () => {
    const receivedIds = []
    const { server, url } = await startFakeUpstream((req, res, body) => {
      setTimeout(() => {
        receivedIds.push(body.id)
        res.writeHead(200)
        res.end()
      }, 400)
    })
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    await makeTransfer(alice.id, bob.id, 'poll-guard-1')

    const poll = createGuardedPoll(() => relayOnce({ pool, targetUrl: url, batchSize: 10, maxAttempts: 5 }))
    const firstTick = poll()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const secondTick = poll()
    await Promise.all([firstTick, secondTick])

    expect(receivedIds).to.have.length(1)
    await stopFakeUpstream(server)
  })
})
