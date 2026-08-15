import express from 'express'
import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import RateLimit from '../src/models/rateLimit.js'
import { seedUser, seedUsers } from '../src/seed.js'
import { rateLimit } from '../src/middleware/rateLimit.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

function buildLimitedApp(options) {
  const limited = express()
  limited.use(rateLimit({ ...options, keyBy: (req) => req.get('x-test-key') }))
  limited.get('/', (req, res) => res.json({ ok: true }))
  return limited
}

function buildStackedApp(first, second) {
  const limited = express()
  limited.use(rateLimit({ ...first, keyBy: (req) => `first:${req.get('x-test-key')}` }))
  limited.use(rateLimit({ ...second, keyBy: (req) => `second:${req.get('x-test-key')}` }))
  limited.get('/', (req, res) => res.json({ ok: true }))
  return limited
}

describe('rate limiting', () => {
  useTestDb()

  it('blocks the 6th login attempt in a window', async () => {
    await seedUsers()

    for (let i = 0; i < 5; i++) {
      const res = await request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: 'wrong' })
      expect(res).to.have.status(401)
    }
    const blocked = await request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: 'wrong' })

    expect(blocked).to.have.status(429)
    expect(blocked.body).to.deep.equal({ error: 'too many requests' })
  })

  it('blocks the 11th reset-password attempt in a window', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request.execute(app).post('/api/auth/reset-password').send({ token: 'unknowntoken', password: 'irrelevant1' })
      expect(res).to.have.status(400)
    }
    const blocked = await request.execute(app).post('/api/auth/reset-password').send({ token: 'unknowntoken', password: 'irrelevant1' })

    expect(blocked).to.have.status(429)
    expect(blocked.body).to.deep.equal({ error: 'too many requests' })
  })

  it('carries RateLimit headers on both allowed and blocked responses', async () => {
    const limited = buildLimitedApp({ limit: 2, windowMs: 60000 })

    const first = await request.execute(limited).get('/').set('x-test-key', 'headers-key')
    const second = await request.execute(limited).get('/').set('x-test-key', 'headers-key')
    const third = await request.execute(limited).get('/').set('x-test-key', 'headers-key')

    expect(first).to.have.status(200)
    expect(first.headers['ratelimit-limit']).to.equal('2')
    expect(first.headers['ratelimit-remaining']).to.equal('1')
    expect(second).to.have.status(200)
    expect(second.headers['ratelimit-remaining']).to.equal('0')
    expect(third).to.have.status(429)
    expect(third.headers['retry-after']).to.be.a('string')
    expect(third.headers['ratelimit-remaining']).to.equal('0')
  })

  it('keys limits independently, so a different key still passes', async () => {
    const limited = buildLimitedApp({ limit: 1, windowMs: 60000 })

    const first = await request.execute(limited).get('/').set('x-test-key', 'user-a')
    const blockedSameKey = await request.execute(limited).get('/').set('x-test-key', 'user-a')
    const secondKey = await request.execute(limited).get('/').set('x-test-key', 'user-b')

    expect(first).to.have.status(200)
    expect(blockedSameKey).to.have.status(429)
    expect(secondKey).to.have.status(200)
  })

  it('rolls to a new window instead of blocking once the stored window has passed', async () => {
    const limited = buildLimitedApp({ limit: 2, windowMs: 60000 })
    const pastWindowStart = Math.floor((Date.now() - 120000) / 60000) * 60000
    await RateLimit.create({ key: 'roller', windowStart: pastWindowStart, count: 999, expiresAt: new Date(pastWindowStart + 60000) })

    const res = await request.execute(limited).get('/').set('x-test-key', 'roller')

    expect(res).to.have.status(200)
    expect(res.headers['ratelimit-remaining']).to.equal('1')
  })

  it('allows exactly the configured number of concurrent requests', async () => {
    const limited = buildLimitedApp({ limit: 5, windowMs: 60000 })

    const responses = await Promise.all(Array.from({ length: 10 }, () => request.execute(limited).get('/').set('x-test-key', 'concurrent-key')))

    const allowed = responses.filter((res) => res.status === 200)
    const blocked = responses.filter((res) => res.status === 429)
    expect(allowed).to.have.length(5)
    expect(blocked).to.have.length(5)
  })

  it('reports the binding limiter on login, not the last one to run', async () => {
    for (let i = 0; i < 3; i++) {
      await request.execute(app).post('/api/auth/login').send({ email: 'a@shop.test', password: 'wrong' })
    }

    const res = await request.execute(app).post('/api/auth/login').send({ email: 'b@shop.test', password: 'wrong' })

    expect(res.headers['ratelimit-remaining']).to.equal('1')
  })

  it('reports the most restrictive stacked policy whichever order the limiters run in', async () => {
    const looseThenTight = buildStackedApp({ limit: 10, windowMs: 60000 }, { limit: 2, windowMs: 60000 })
    const tightThenLoose = buildStackedApp({ limit: 2, windowMs: 60000 }, { limit: 10, windowMs: 60000 })

    const first = await request.execute(looseThenTight).get('/').set('x-test-key', 'loose-first')
    const second = await request.execute(tightThenLoose).get('/').set('x-test-key', 'tight-first')

    expect(first.headers['ratelimit-remaining']).to.equal('1')
    expect(first.headers['ratelimit-limit']).to.equal('2')
    expect(second.headers['ratelimit-remaining']).to.equal('1')
    expect(second.headers['ratelimit-limit']).to.equal('2')
  })

  it('fails open when the counter store throws', async () => {
    const throwingStore = { incrementWindow: async () => { throw new Error('store unavailable') } }
    const limited = buildLimitedApp({ limit: 1, windowMs: 60000, store: throwingStore })

    const first = await request.execute(limited).get('/').set('x-test-key', 'fail-open-key')
    const second = await request.execute(limited).get('/').set('x-test-key', 'fail-open-key')

    expect(first).to.have.status(200)
    expect(second).to.have.status(200)
  })
})
