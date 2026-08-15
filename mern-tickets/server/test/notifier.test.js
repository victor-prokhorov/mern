import http from 'node:http'
import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import { createNotifier, notify as notifySingleton, stats as singletonStats, reset as resetSingleton } from '../src/notifier/webhook.js'
import { seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

function startFakeUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function stopFakeUpstream(server) {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(resolve))
}

function urlFor(server) {
  return `http://127.0.0.1:${server.address().port}`
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

describe('webhook notifier', () => {
  it('records a success against the upstream on a 200 response', async () => {
    const server = await startFakeUpstream((req, res) => { res.writeHead(200); res.end() })
    const notifier = createNotifier({ url: urlFor(server), minimumThroughput: 1, failureRateThreshold: 0.5 })

    await notifier.notify({ type: 'ticket:created' })

    expect(notifier.state).to.equal('closed')
    expect(notifier.stats().successes).to.equal(1)
    await stopFakeUpstream(server)
  })

  it('trips the breaker after enough failing responses and stops reaching the upstream', async () => {
    let requestCount = 0
    const server = await startFakeUpstream((req, res) => { requestCount += 1; res.writeHead(500); res.end() })
    const notifier = createNotifier({ url: urlFor(server), minimumThroughput: 3, failureRateThreshold: 0.5 })
    for (let i = 0; i < 3; i++) await notifier.notify({ type: 'ticket:created' })

    await notifier.notify({ type: 'ticket:created' })

    expect(notifier.state).to.equal('open')
    expect(requestCount).to.equal(3)
    await stopFakeUpstream(server)
  })

  it('counts a hung request as a failure once the timeout fires', async () => {
    const server = await startFakeUpstream(() => {})
    const notifier = createNotifier({ url: urlFor(server), timeoutMs: 50, minimumThroughput: 5 })

    await notifier.notify({ type: 'ticket:created' })

    expect(notifier.stats().failures).to.equal(1)
    await stopFakeUpstream(server)
  })

  it('does not trip the breaker on a 400 response', async () => {
    const server = await startFakeUpstream((req, res) => { res.writeHead(400); res.end() })
    const notifier = createNotifier({ url: urlFor(server), minimumThroughput: 1, failureRateThreshold: 0.5 })

    for (let i = 0; i < 5; i++) await notifier.notify({ type: 'ticket:created' })

    expect(notifier.state).to.equal('closed')
    expect(notifier.stats().failures).to.equal(0)
    await stopFakeUpstream(server)
  })

  it('recovers after openMs once the upstream is healthy again', async () => {
    let currentTime = 0
    let shouldFail = true
    const server = await startFakeUpstream((req, res) => { res.writeHead(shouldFail ? 500 : 200); res.end() })
    const notifier = createNotifier({ url: urlFor(server), now: () => currentTime, minimumThroughput: 1, failureRateThreshold: 0.5, openMs: 1000 })
    await notifier.notify({ type: 'ticket:created' })
    shouldFail = false
    currentTime = 1000

    await notifier.notify({ type: 'ticket:created' })

    expect(notifier.state).to.equal('closed')
    await stopFakeUpstream(server)
  })

  it('is a no-op without a configured webhook url', async () => {
    const notifier = createNotifier({})
    const originalFetch = globalThis.fetch
    globalThis.fetch = () => { throw new Error('fetch should not be called') }

    await notifier.notify({ type: 'ticket:created' })
    globalThis.fetch = originalFetch

    expect(notifier.stats().total).to.equal(0)
  })

  it('does not wedge open after a half-open trial gets a response isWebhookFailure excludes', async () => {
    let currentTime = 0
    let callCount = 0
    const server = await startFakeUpstream((req, res) => {
      callCount += 1
      if (callCount === 1) { res.writeHead(500); res.end(); return }
      if (callCount === 2) { res.writeHead(400); res.end(); return }
      res.writeHead(200)
      res.end()
    })
    const notifier = createNotifier({ url: urlFor(server), now: () => currentTime, minimumThroughput: 1, failureRateThreshold: 0.5, openMs: 1000 })
    await notifier.notify({ type: 'ticket:created' })
    currentTime = 1000
    await notifier.notify({ type: 'ticket:created' })
    currentTime = 2000

    await notifier.notify({ type: 'ticket:created' })

    expect(notifier.state).to.equal('closed')
    await stopFakeUpstream(server)
  })

  describe('wired into ticket creation', () => {
    useTestDb()
    beforeEach(() => resetSingleton())

    it('sends a webhook notification when a ticket is created, without blocking the response', async () => {
      let requestCount = 0
      const server = await startFakeUpstream((req, res) => { requestCount += 1; res.writeHead(200); res.end() })
      process.env.TICKET_WEBHOOK_URL = urlFor(server)
      const [, , , rae] = await seedUsers()

      const res = await request
        .execute(app)
        .post('/api/tickets')
        .set('x-user-id', rae._id.toString())
        .send({ title: 't', body: 'webhook notification test', priority: 'normal' })
      await waitUntil(() => requestCount > 0)

      expect(res).to.have.status(201)
      expect(requestCount).to.equal(1)
      delete process.env.TICKET_WEBHOOK_URL
      await stopFakeUpstream(server)
    })

    it('still creates the ticket and returns 201 while the webhook breaker is open', async () => {
      const server = await startFakeUpstream((req, res) => { res.writeHead(500); res.end() })
      process.env.TICKET_WEBHOOK_URL = urlFor(server)
      for (let i = 0; i < 5; i++) await notifySingleton({ type: 'ticket:created' })
      const [, , , rae] = await seedUsers()

      const res = await request
        .execute(app)
        .post('/api/tickets')
        .set('x-user-id', rae._id.toString())
        .send({ title: 't', body: 'still creates while breaker open', priority: 'normal' })

      expect(singletonStats().state).to.equal('open')
      expect(res).to.have.status(201)
      delete process.env.TICKET_WEBHOOK_URL
      await stopFakeUpstream(server)
    })

    it('returns the create response well before a slow webhook call would resolve', async () => {
      const server = await startFakeUpstream((req, res) => { setTimeout(() => { res.writeHead(200); res.end() }, 300) })
      process.env.TICKET_WEBHOOK_URL = urlFor(server)
      const [, , , rae] = await seedUsers()
      const start = Date.now()

      const res = await request
        .execute(app)
        .post('/api/tickets')
        .set('x-user-id', rae._id.toString())
        .send({ title: 't', body: 'must not wait on a slow webhook', priority: 'normal' })
      const elapsed = Date.now() - start

      expect(res).to.have.status(201)
      expect(elapsed).to.be.lessThan(150)
      delete process.env.TICKET_WEBHOOK_URL
      await stopFakeUpstream(server)
    })
  })
})
