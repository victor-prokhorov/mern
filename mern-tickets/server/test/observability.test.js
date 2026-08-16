import http from 'node:http'
import mongoose from 'mongoose'
import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import { connect } from '../src/db.js'
import { seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'
import { runWithContext, getContext } from '../src/observability/context.js'
import { logger, setWriter, resetWriter } from '../src/observability/logger.js'
import { register, run, reset as resetHooks } from '../src/hooks/registry.js'
import { createCircuitBreaker } from '../src/circuitBreaker/breaker.js'
import { reset as resetMetrics, renderMetrics } from '../src/observability/metrics.js'
import { createNotifier } from '../src/notifier/webhook.js'
import { routeTemplateFor } from '../src/observability/routeTemplate.js'
import { createGracefulShutdown } from '../src/observability/shutdown.js'
import { setReady, isReady } from '../src/observability/health.js'

use(chaiHttp)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function captureLines() {
  const lines = []
  setWriter((line) => lines.push(JSON.parse(line)))
  return lines
}

function mountPathOf(layer) {
  if (layer.regexp.fast_slash) return ''
  return layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/')
}

function collectRoutes(stack, prefix) {
  const collected = []
  for (const layer of stack) {
    if (layer.route) {
      const path = layer.route.path === '/' ? prefix || '/' : `${prefix}${layer.route.path}`
      for (const method of Object.keys(layer.route.methods)) collected.push({ method: method.toUpperCase(), path })
    } else if (layer.handle && layer.handle.stack) {
      collected.push(...collectRoutes(layer.handle.stack, `${prefix}${mountPathOf(layer)}`))
    }
  }
  return collected
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

describe('observability', () => {
  afterEach(() => {
    resetWriter()
  })

  describe('request id middleware', () => {
    useTestDb()

    it('echoes an inbound X-Request-Id on the response', async () => {
      const res = await request.execute(app).get('/healthz').set('X-Request-Id', 'caller-supplied-id')

      expect(res.headers['x-request-id']).to.equal('caller-supplied-id')
    })

    it('mints a fresh request id when none is provided', async () => {
      const res = await request.execute(app).get('/healthz')

      expect(res.headers['x-request-id']).to.match(UUID_PATTERN)
    })

    it('replaces a malformed inbound request id rather than trusting it', async () => {
      const res = await request.execute(app).get('/healthz').set('X-Request-Id', 'not a valid id!!')

      expect(res.headers['x-request-id']).to.not.equal('not a valid id!!')
      expect(res.headers['x-request-id']).to.match(UUID_PATTERN)
    })
  })

  describe('context propagation into the call tree', () => {
    afterEach(() => {
      resetHooks('observability:test')
      resetHooks('observability:isolation')
    })

    it('carries the request id into a hook handler\'s log line', async () => {
      const lines = captureLines()
      register('observability:test', () => {
        logger.info('handler ran')
        throw new Error('boom')
      })

      await runWithContext({ requestId: 'req-in-hook', userId: null, route: '/test' }, () => run('observability:test', {}))

      const handlerLine = lines.find((line) => line.msg === 'handler ran')
      const failureLine = lines.find((line) => line.msg === 'hook handler failed')
      expect(handlerLine.requestId).to.equal('req-in-hook')
      expect(failureLine.requestId).to.equal('req-in-hook')
    })

    it('carries the request id into a circuit breaker state-change log line', async () => {
      const lines = captureLines()
      const breaker = createCircuitBreaker({
        minimumThroughput: 1,
        failureRateThreshold: 0.5,
        onStateChange: (event) => logger.warn('breaker transitioned', { from: event.from, to: event.to })
      })

      await runWithContext({ requestId: 'req-in-breaker', userId: null, route: '/test' }, async () => {
        try {
          await breaker.call(() => { throw new Error('boom') })
        } catch (err) {
          return err
        }
      })

      const transitionLine = lines.find((line) => line.msg === 'breaker transitioned')
      expect(transitionLine.requestId).to.equal('req-in-breaker')
    })

    it('keeps two concurrent requests\' ids isolated across a real await inside a hook handler', async () => {
      const observed = []
      register('observability:isolation', async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, payload.delayMs))
        observed.push({ expected: payload.requestId, actual: getContext().requestId })
        return { action: 'continue' }
      })

      await Promise.all([
        runWithContext({ requestId: 'req-slow', userId: null, route: '/test' }, () => run('observability:isolation', { requestId: 'req-slow', delayMs: 30 })),
        runWithContext({ requestId: 'req-fast', userId: null, route: '/test' }, () => run('observability:isolation', { requestId: 'req-fast', delayMs: 5 }))
      ])

      expect(observed).to.have.length(2)
      for (const entry of observed) expect(entry.actual).to.equal(entry.expected)
    })
  })

  describe('structured log fields', () => {
    it('emits level, msg, time and no string-interpolated variable data in the message', () => {
      const lines = captureLines()

      logger.info('ticket created', { ticketId: 'abc123' })

      expect(lines[0].msg).to.equal('ticket created')
      expect(lines[0].level).to.equal('info')
      expect(lines[0].time).to.be.a('string')
      expect(lines[0].ticketId).to.equal('abc123')
    })
  })

  describe('end to end through a real request', () => {
    useTestDb()
    afterEach(() => {
      delete process.env.TICKET_WEBHOOK_URL
    })

    it('propagates one request\'s id from the HTTP header through to an async webhook log line', async () => {
      const server = http.createServer((req, res) => { res.writeHead(500); res.end() })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      process.env.TICKET_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}`
      const lines = captureLines()
      const [, , , rae] = await seedUsers()

      const res = await request
        .execute(app)
        .post('/api/tickets')
        .set('x-user-id', rae._id.toString())
        .set('X-Request-Id', 'req-end-to-end')
        .send({ title: 't', body: 'observability propagation test', priority: 'normal' })
      await waitUntil(() => lines.some((line) => line.msg === 'webhook notify failed'))

      expect(res.headers['x-request-id']).to.equal('req-end-to-end')
      const notifyFailedLine = lines.find((line) => line.msg === 'webhook notify failed')
      expect(notifyFailedLine.requestId).to.equal('req-end-to-end')
      await new Promise((resolve) => server.close(resolve))
    })
  })

  describe('RED metrics', () => {
    useTestDb()
    beforeEach(() => resetMetrics())

    it('counts requests and classifies status by class, labeled by route template not a concrete ticket id', async () => {
      const [, , , rae] = await seedUsers()
      const created = await request.execute(app).post('/api/tickets').set('x-user-id', rae._id.toString()).send({ title: 't', body: 'metrics test body', priority: 'normal' })
      await request.execute(app).get(`/api/tickets/${created.body._id}`).set('x-user-id', rae._id.toString())
      await request.execute(app).get('/api/tickets/000000000000000000000000').set('x-user-id', rae._id.toString())

      const metricsRes = await request.execute(app).get('/metrics')

      expect(metricsRes.text).to.include('http_requests_total{method="GET",route="/api/tickets/:id",status_class="2xx"} 1')
      expect(metricsRes.text).to.include('http_requests_total{method="GET",route="/api/tickets/:id",status_class="4xx"} 1')
      expect(metricsRes.text).to.not.include(created.body._id)
    })

    it('never lets a concrete ticket id leak into a metrics label', async () => {
      const [, , , rae] = await seedUsers()
      const first = await request.execute(app).post('/api/tickets').set('x-user-id', rae._id.toString()).send({ title: 't1', body: 'first ticket body', priority: 'normal' })
      const second = await request.execute(app).post('/api/tickets').set('x-user-id', rae._id.toString()).send({ title: 't2', body: 'second ticket body', priority: 'normal' })
      await request.execute(app).get(`/api/tickets/${first.body._id}`).set('x-user-id', rae._id.toString())
      await request.execute(app).get(`/api/tickets/${second.body._id}`).set('x-user-id', rae._id.toString())

      const metricsRes = await request.execute(app).get('/metrics')

      expect(metricsRes.text).to.not.include(first.body._id)
      expect(metricsRes.text).to.not.include(second.body._id)
      expect(metricsRes.text).to.include('route="/api/tickets/:id"')
    })
  })

  describe('route template coverage', () => {
    it('templates every route the Express app actually registers, so a new route cannot silently become route="unmatched"', () => {
      const registered = collectRoutes(app._router.stack, '')

      const templated = registered.map((route) => ({ ...route, template: routeTemplateFor(route.method, route.path.replace(/:[^/]+/g, 'probe-segment')) }))

      expect(registered.map((route) => `${route.method} ${route.path}`)).to.include('GET /api/tickets/:id')
      expect(templated.filter((route) => route.template === 'unmatched')).to.deep.equal([])
      expect(templated.filter((route) => route.template !== route.path)).to.deep.equal([])
    })
  })

  describe('circuit breaker metrics', () => {
    beforeEach(() => resetMetrics())

    it('exports a breaker transition as both a state gauge and a transitions counter', async () => {
      const server = http.createServer((req, res) => { res.writeHead(500); res.end() })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const notifier = createNotifier({ url: `http://127.0.0.1:${server.address().port}`, minimumThroughput: 1, failureRateThreshold: 0.5 })

      await notifier.notify({ type: 'ticket_created' })
      const rendered = renderMetrics()

      expect(notifier.state).to.equal('open')
      expect(rendered).to.include('circuit_breaker_state{breaker="webhook",state="open"} 1')
      expect(rendered).to.include('circuit_breaker_state{breaker="webhook",state="closed"} 0')
      expect(rendered).to.include('circuit_breaker_transitions_total{breaker="webhook",from="closed",to="open"} 1')
      await new Promise((resolve) => server.close(resolve))
    })
  })

  describe('health endpoints', () => {
    useTestDb()

    it('answers healthz without touching the database', async () => {
      const res = await request.execute(app).get('/healthz')

      expect(res).to.have.status(200)
    })

    it('passes readyz when Mongo is connected', async () => {
      const res = await request.execute(app).get('/readyz')

      expect(res).to.have.status(200)
    })

    it('setReady updates what isReady reports, which readyz then reflects', async () => {
      setReady(false)

      const res = await request.execute(app).get('/readyz')

      expect(isReady()).to.equal(false)
      expect(res).to.have.status(503)
      setReady(true)
    })

    it('fails readyz when Mongo is disconnected while healthz still passes', async () => {
      await mongoose.disconnect()

      const readyRes = await request.execute(app).get('/readyz')
      const liveRes = await request.execute(app).get('/healthz')

      expect(readyRes).to.have.status(503)
      expect(liveRes).to.have.status(200)
      await connect(process.env.MONGO_URI)
    })
  })

  describe('graceful shutdown', () => {
    it('flips readiness before draining, lets an in-flight request finish, then closes the store and exits', async () => {
      const events = []
      let releaseResponse
      const server = http.createServer((req, res) => {
        new Promise((resolve) => { releaseResponse = resolve }).then(() => {
          res.writeHead(200)
          res.end('done')
        })
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = server.address().port
      const originalClose = server.close.bind(server)
      server.close = (callback) => {
        events.push('close-called')
        return originalClose(callback)
      }
      const shutdown = createGracefulShutdown({
        server,
        closeStore: async () => { events.push('store-closed') },
        setNotReady: () => events.push('not-ready'),
        exit: () => events.push('exited')
      })

      const responsePromise = fetch(`http://127.0.0.1:${port}`)
      await waitUntil(() => releaseResponse !== undefined)
      const shutdownPromise = shutdown()
      await new Promise((resolve) => setTimeout(resolve, 20))
      releaseResponse()
      const res = await responsePromise
      await shutdownPromise

      expect(res.status).to.equal(200)
      expect(events).to.deep.equal(['not-ready', 'close-called', 'store-closed', 'exited'])
    })
  })
})
