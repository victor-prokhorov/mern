import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import TokenBucket from '../src/models/tokenBucket.js'
import { consume } from '../src/throttle/tokenBucket.js'
import { seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

describe('token bucket throttling', () => {
  useTestDb()

  it('allows a burst up to the configured size then blocks', async () => {
    const now = new Date()

    const results = []
    for (let i = 0; i < 6; i++) {
      results.push(await consume('user-1', 'ticket:create', now))
    }

    expect(results.slice(0, 5).every((r) => r.allowed)).to.equal(true)
    expect(results[5].allowed).to.equal(false)
  })

  it('lazily refills tokens proportionally to elapsed time', async () => {
    const now = new Date()
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000)
    await TokenBucket.create({ key: 'user-2:ticket:create', tokens: 0, updatedAt: twoMinutesAgo })

    const result = await consume('user-2', 'ticket:create', now)

    expect(result.allowed).to.equal(true)
    expect(result.tokens).to.equal(1)
  })

  it('sets Retry-After to the time until the next whole token', async () => {
    const now = new Date()
    await TokenBucket.create({ key: 'user-3:ticket:create', tokens: 0, updatedAt: now })

    const result = await consume('user-3', 'ticket:create', now)

    expect(result.allowed).to.equal(false)
    expect(result.retryAfter).to.equal(60)
  })

  it('scopes a lower Retry-After to a faster-refilling action', async () => {
    const now = new Date()
    await TokenBucket.create({ key: 'user-4:comment:create', tokens: 0, updatedAt: now })

    const result = await consume('user-4', 'comment:create', now)

    expect(result.allowed).to.equal(false)
    expect(result.retryAfter).to.equal(12)
  })

  it('keeps buckets separate per user and per action', async () => {
    const now = new Date()
    for (let i = 0; i < 5; i++) await consume('user-5', 'ticket:create', now)

    const otherUser = await consume('user-6', 'ticket:create', now)
    const otherAction = await consume('user-5', 'comment:create', now)

    expect(otherUser.allowed).to.equal(true)
    expect(otherAction.allowed).to.equal(true)
  })

  it('never throws under heavy concurrent contention for the same bucket', async () => {
    const now = new Date()
    const attempts = Array.from({ length: 30 }, () => consume('contended-user', 'comment:create', now))

    const results = await Promise.all(attempts)

    const allowedCount = results.filter((r) => r.allowed).length
    expect(allowedCount).to.equal(20)
    expect(results.every((r) => typeof r.allowed === 'boolean')).to.equal(true)
    expect(results.filter((r) => !r.allowed).every((r) => Number.isFinite(r.retryAfter))).to.equal(true)
  })

  it('responds 429 with a Retry-After header once the burst is exhausted over HTTP', async () => {
    const [, , , rae] = await seedUsers()

    for (let i = 0; i < 5; i++) {
      await request
        .execute(app)
        .post('/api/tickets')
        .set('x-user-id', rae._id.toString())
        .send({ title: 't', body: `body number ${i}`, priority: 'normal' })
    }

    const res = await request
      .execute(app)
      .post('/api/tickets')
      .set('x-user-id', rae._id.toString())
      .send({ title: 't', body: 'one too many', priority: 'normal' })

    expect(res).to.have.status(429)
    expect(res).to.have.header('retry-after', '60')
  })
})
