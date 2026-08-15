import bcrypt from 'bcrypt'
import express from 'express'
import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Order from '../src/models/order.js'
import Cart from '../src/models/cart.js'
import Product from '../src/models/product.js'
import IdempotencyKey from '../src/models/idempotencyKey.js'
import { seedUser, seedUsers } from '../src/seed.js'
import { idempotency } from '../src/middleware/idempotency.js'
import * as idempotencyKeysRepo from '../src/repositories/idempotencyKeys.js'
import * as usersRepo from '../src/repositories/users.js'
import { computeFingerprint } from '../src/idempotency/fingerprint.js'
import { useTestDb, loginAs } from './helpers.js'

use(chaiHttp)

const testUserConcurrent = '64b7f0f0f0f0f0f0f0f0f0f1'
const testUser5xx = '64b7f0f0f0f0f0f0f0f0f0f2'
const testUser4xx = '64b7f0f0f0f0f0f0f0f0f0f3'
const testUserSlowComplete = '64b7f0f0f0f0f0f0f0f0f0f4'
const testUserSlowRelease = '64b7f0f0f0f0f0f0f0f0f0f5'
const testUserClaimRace = '64b7f0f0f0f0f0f0f0f0f0f6'
const testUserStale = '64b7f0f0f0f0f0f0f0f0f0f7'
const testUserLeaseFresh = '64b7f0f0f0f0f0f0f0f0f0f8'
const testUserLogging = '64b7f0f0f0f0f0f0f0f0f0f9'
const testUserFencing = '64b7f0f0f0f0f0f0f0f0f0fa'

const customer = { name: 'Ada', email: 'ada@shop.test', address: '1 Main Street' }

async function setUpCart(cartId = 'cart-1') {
  await seedUsers()
  const mug = await Product.create({ name: 'Mug', price: 12, stock: 3 })
  const poster = await Product.create({ name: 'Poster', price: 20, stock: 5 })
  await Cart.create({ cartId, items: [{ product: mug._id, qty: 2 }, { product: poster._id, qty: 1 }] })
  const session = await loginAs(app, seedUser.email, seedUser.password)
  return { accessToken: session.accessToken }
}

function buildSlowIdempotentApp(delayMs) {
  const built = express()
  built.use(express.json())
  built.use('/orders', idempotency({ userIdFrom: (req) => req.get('x-test-user') }), (req, res) => {
    setTimeout(() => res.status(201).json({ ok: true, receivedAt: Date.now() }), delayMs)
  })
  return built
}

function buildFailingIdempotentApp(status) {
  const built = express()
  built.use(express.json())
  built.use('/orders', idempotency({ userIdFrom: (req) => req.get('x-test-user') }), (req, res) => {
    res.status(status).json({ error: 'boom' })
  })
  return built
}

function buildLeasedApp(leaseMs, delayMs) {
  const built = express()
  built.use(express.json())
  built.use('/orders', idempotency({ userIdFrom: (req) => req.get('x-test-user'), leaseMs }), (req, res) => {
    setTimeout(() => res.status(201).json({ ok: true }), delayMs)
  })
  return built
}

function buildAppWithStoreAndStatus(store, status) {
  const built = express()
  built.use(express.json())
  built.use('/orders', idempotency({ store, userIdFrom: (req) => req.get('x-test-user') }), (req, res) => {
    res.status(status).json({ ok: true })
  })
  return built
}

function buildExecutionCountingApp(leaseMs, counterRef) {
  const built = express()
  built.use(express.json())
  built.use('/orders', idempotency({ userIdFrom: (req) => req.get('x-test-user'), leaseMs }), async (req, res) => {
    counterRef.count += 1
    const myExecution = counterRef.count
    const delayMs = Number(req.get('x-test-delay') || 0)
    await delay(delayMs)
    if (req.get('x-test-fail') === 'true') {
      res.status(500).json({ execution: myExecution })
    } else {
      res.status(201).json({ execution: myExecution })
    }
  })
  return built
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildSlowStoreApp(status, delayMs) {
  const store = {
    claim: idempotencyKeysRepo.claim,
    findByKeyAndUser: idempotencyKeysRepo.findByKeyAndUser,
    markCompleted: async (id, response) => {
      await delay(delayMs)
      return idempotencyKeysRepo.markCompleted(id, response)
    },
    release: async (id) => {
      await delay(delayMs)
      return idempotencyKeysRepo.release(id)
    }
  }
  const built = express()
  built.use(express.json())
  built.use('/orders', idempotency({ store, userIdFrom: (req) => req.get('x-test-user') }), (req, res) => {
    res.status(status).json({ ok: true })
  })
  return built
}

describe('idempotency keys', () => {
  useTestDb()

  it('replaying a key returns the identical body and creates exactly one order', async () => {
    const { accessToken } = await setUpCart()
    const body = { cartId: 'cart-1', customer }

    const first = await request.execute(app).post('/api/orders').set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', 'key-1').send(body)
    const second = await request.execute(app).post('/api/orders').set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', 'key-1').send(body)

    expect(first).to.have.status(201)
    expect(second).to.have.status(201)
    expect(second.body).to.deep.equal(first.body)
    const count = await Order.countDocuments({})
    expect(count).to.equal(1)
  })

  it('a replay carries the replay header and does not touch the cart again', async () => {
    const { accessToken } = await setUpCart()
    const body = { cartId: 'cart-1', customer }
    await request.execute(app).post('/api/orders').set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', 'key-2').send(body)

    const replay = await request.execute(app).post('/api/orders').set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', 'key-2').send(body)

    expect(replay.headers['idempotent-replay']).to.equal('true')
    const cart = await Cart.findOne({ cartId: 'cart-1' })
    expect(cart.items).to.have.length(0)
    const count = await Order.countDocuments({})
    expect(count).to.equal(1)
  })

  it('a second, different key creates a second order', async () => {
    const { accessToken } = await setUpCart()
    const body = { cartId: 'cart-1', customer }
    await request.execute(app).post('/api/orders').set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', 'key-3a').send(body)
    await Cart.updateOne({ cartId: 'cart-1' }, { items: [{ product: (await Product.findOne({ name: 'Mug' }))._id, qty: 1 }] })

    const second = await request.execute(app).post('/api/orders').set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', 'key-3b').send(body)

    expect(second).to.have.status(201)
    const count = await Order.countDocuments({})
    expect(count).to.equal(2)
  })

  it('the same key with a different body is rejected with 422', async () => {
    const { accessToken } = await setUpCart()
    const body = { cartId: 'cart-1', customer }
    await request.execute(app).post('/api/orders').set('Authorization', `Bearer ${accessToken}`).set('Idempotency-Key', 'key-4').send(body)

    const conflict = await request
      .execute(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'key-4')
      .send({ ...body, customer: { ...customer, name: 'Bea' } })

    expect(conflict).to.have.status(422)
  })

  it('a concurrent replay while the first is in flight is 409', async () => {
    const slow = buildSlowIdempotentApp(80)

    const [first, second] = await Promise.all([
      request.execute(slow).post('/orders').set('x-test-user', testUserConcurrent).set('Idempotency-Key', 'key-5').send({ a: 1 }),
      request.execute(slow).post('/orders').set('x-test-user', testUserConcurrent).set('Idempotency-Key', 'key-5').send({ a: 1 })
    ])

    const statuses = [first.status, second.status].sort()
    expect(statuses).to.deep.equal([201, 409])
    const conflict = first.status === 409 ? first : second
    expect(conflict.headers['retry-after']).to.be.a('string')
  })

  it('scopes keys per user, so the same key string from another user does not collide', async () => {
    const { accessToken: tokenA } = await setUpCart('cart-a')
    const passwordHash = await bcrypt.hash('ben-secret-passphrase', 10)
    await usersRepo.create({ name: 'Ben', email: 'ben@shop.test', passwordHash })
    const sessionB = await loginAs(app, 'ben@shop.test', 'ben-secret-passphrase')
    await Cart.create({ cartId: 'cart-b', items: [{ product: (await Product.findOne({ name: 'Mug' }))._id, qty: 1 }] })

    const first = await request.execute(app).post('/api/orders').set('Authorization', `Bearer ${tokenA}`).set('Idempotency-Key', 'shared-key').send({ cartId: 'cart-a', customer })
    const second = await request
      .execute(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${sessionB.accessToken}`)
      .set('Idempotency-Key', 'shared-key')
      .send({ cartId: 'cart-b', customer })

    expect(first).to.have.status(201)
    expect(second).to.have.status(201)
    const count = await Order.countDocuments({})
    expect(count).to.equal(2)
  })

  it('a 5xx leaves the key reusable', async () => {
    const failing = buildFailingIdempotentApp(500)

    const first = await request.execute(failing).post('/orders').set('x-test-user', testUser5xx).set('Idempotency-Key', 'key-6').send({ a: 1 })
    const existingAfterFirst = await idempotencyKeysRepo.findByKeyAndUser('key-6', testUser5xx)
    const second = await request.execute(failing).post('/orders').set('x-test-user', testUser5xx).set('Idempotency-Key', 'key-6').send({ a: 1 })

    expect(first).to.have.status(500)
    expect(existingAfterFirst).to.equal(null)
    expect(second).to.have.status(500)
    expect(second.headers['idempotent-replay']).to.equal(undefined)
  })

  it('a 4xx is replayed verbatim', async () => {
    const failing = buildFailingIdempotentApp(400)

    const first = await request.execute(failing).post('/orders').set('x-test-user', testUser4xx).set('Idempotency-Key', 'key-7').send({ a: 1 })
    const second = await request.execute(failing).post('/orders').set('x-test-user', testUser4xx).set('Idempotency-Key', 'key-7').send({ a: 1 })

    expect(first).to.have.status(400)
    expect(second).to.have.status(400)
    expect(second.body).to.deep.equal(first.body)
    expect(second.headers['idempotent-replay']).to.equal('true')
  })

  it('fingerprints the same JSON regardless of key order, but changes when a value changes', async () => {
    const a = computeFingerprint({ cartId: 'cart-1', customer: { name: 'Ada', email: 'ada@shop.test' } })
    const b = computeFingerprint({ customer: { email: 'ada@shop.test', name: 'Ada' }, cartId: 'cart-1' })
    const c = computeFingerprint({ cartId: 'cart-1', customer: { name: 'Ada', email: 'different@shop.test' } })

    expect(a).to.equal(b)
    expect(a).to.not.equal(c)
  })

  it('stores the completed response before answering, so an immediate replay never races the write', async () => {
    const slowStoreApp = buildSlowStoreApp(201, 150)

    const first = await request.execute(slowStoreApp).post('/orders').set('x-test-user', testUserSlowComplete).set('Idempotency-Key', 'slow-complete-key').send({ a: 1 })
    const second = await request.execute(slowStoreApp).post('/orders').set('x-test-user', testUserSlowComplete).set('Idempotency-Key', 'slow-complete-key').send({ a: 1 })

    expect(first).to.have.status(201)
    expect(second).to.have.status(201)
    expect(second.headers['idempotent-replay']).to.equal('true')
  })

  it('releases the claim before answering on a 5xx, so an immediate retry never races the delete', async () => {
    const slowStoreApp = buildSlowStoreApp(500, 150)

    const first = await request.execute(slowStoreApp).post('/orders').set('x-test-user', testUserSlowRelease).set('Idempotency-Key', 'slow-release-key').send({ a: 1 })
    const second = await request.execute(slowStoreApp).post('/orders').set('x-test-user', testUserSlowRelease).set('Idempotency-Key', 'slow-release-key').send({ a: 1 })

    expect(first).to.have.status(500)
    expect(second).to.have.status(500)
    expect(second.headers['idempotent-replay']).to.equal(undefined)
  })

  it('claim is atomic: hammering the same key and user concurrently produces exactly one winner', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => idempotencyKeysRepo.claim({ key: 'race-key', user: testUserClaimRace, requestFingerprint: 'fp', expiresAt: new Date(Date.now() + 60000) }))
    )

    const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled')
    const failed = attempts.filter((attempt) => attempt.status === 'rejected')
    expect(succeeded).to.have.length(1)
    expect(failed).to.have.length(9)
    failed.forEach((attempt) => expect(attempt.reason.code).to.equal(11000))
  })

  it('claim never silently hands a second caller the first caller\'s already-claimed record', async () => {
    const first = await idempotencyKeysRepo.claim({ key: 'sequential-race-key', user: testUserClaimRace, requestFingerprint: 'fp', expiresAt: new Date(Date.now() + 60000) })

    let secondThrew = false
    let secondCode = null
    try {
      await idempotencyKeysRepo.claim({ key: 'sequential-race-key', user: testUserClaimRace, requestFingerprint: 'fp', expiresAt: new Date(Date.now() + 60000) })
    } catch (err) {
      secondThrew = true
      secondCode = err.code
    }

    expect(first).to.exist
    expect(secondThrew).to.equal(true)
    expect(secondCode).to.equal(11000)
  })

  it('a stale in-progress claim is reclaimed once its lease expires, so a crashed request cannot wedge the key', async () => {
    const leased = buildLeasedApp(50, 0)
    const body = { a: 1 }
    const fingerprint = computeFingerprint(body)
    await IdempotencyKey.create({
      key: 'stale-key',
      user: testUserStale,
      requestFingerprint: fingerprint,
      status: 'in_progress',
      expiresAt: new Date(Date.now() + 60000),
      claimedAt: new Date(Date.now() - 1000)
    })

    const res = await request.execute(leased).post('/orders').set('x-test-user', testUserStale).set('Idempotency-Key', 'stale-key').send(body)

    expect(res).to.have.status(201)
  })

  it('a fresh in-progress claim inside the lease window still 409s instead of being reclaimed', async () => {
    const leased = buildLeasedApp(5000, 80)

    const [first, second] = await Promise.all([
      request.execute(leased).post('/orders').set('x-test-user', testUserLeaseFresh).set('Idempotency-Key', 'fresh-lease-key').send({ a: 1 }),
      request.execute(leased).post('/orders').set('x-test-user', testUserLeaseFresh).set('Idempotency-Key', 'fresh-lease-key').send({ a: 1 })
    ])

    const statuses = [first.status, second.status].sort()
    expect(statuses).to.deep.equal([201, 409])
  })

  it('logs an error with the key and user when persisting the claim outcome fails, on both the completed and released branches', async () => {
    const failingStore = {
      claim: idempotencyKeysRepo.claim,
      findByKeyAndUser: idempotencyKeysRepo.findByKeyAndUser,
      markCompleted: async () => {
        throw new Error('store down')
      },
      release: async () => {
        throw new Error('store down')
      }
    }
    const originalConsoleError = console.error
    const logs = []
    console.error = (...args) => {
      logs.push(args)
    }

    try {
      const completingApp = buildAppWithStoreAndStatus(failingStore, 201)
      await request.execute(completingApp).post('/orders').set('x-test-user', testUserLogging).set('Idempotency-Key', 'log-key-1').send({ a: 1 })
      const failingApp = buildAppWithStoreAndStatus(failingStore, 500)
      await request.execute(failingApp).post('/orders').set('x-test-user', testUserLogging).set('Idempotency-Key', 'log-key-2').send({ a: 1 })
    } finally {
      console.error = originalConsoleError
    }

    expect(logs).to.have.length(2)
    expect(logs[0][0]).to.include('log-key-1')
    expect(logs[0][0]).to.include(testUserLogging)
    expect(logs[1][0]).to.include('log-key-2')
    expect(logs[1][0]).to.include(testUserLogging)
  })

  it('fences the reclaim: a stale owner that finishes late cannot corrupt or steal the reclaimer\'s completed claim', async () => {
    const counterRef = { count: 0 }
    const built = buildExecutionCountingApp(60, counterRef)

    const originalPromise = request
      .execute(built)
      .post('/orders')
      .set('x-test-user', testUserFencing)
      .set('Idempotency-Key', 'fence-key')
      .set('x-test-delay', '300')
      .set('x-test-fail', 'true')
      .send({ a: 1 })
    originalPromise.catch(() => {})
    await delay(100)
    const reclaimerPromise = request
      .execute(built)
      .post('/orders')
      .set('x-test-user', testUserFencing)
      .set('Idempotency-Key', 'fence-key')
      .set('x-test-delay', '20')
      .send({ a: 1 })

    const [original, reclaimer] = await Promise.all([originalPromise, reclaimerPromise])
    const third = await request.execute(built).post('/orders').set('x-test-user', testUserFencing).set('Idempotency-Key', 'fence-key').send({ a: 1 })

    expect(original).to.have.status(500)
    expect(reclaimer).to.have.status(201)
    expect(reclaimer.body.execution).to.equal(2)
    expect(third.headers['idempotent-replay']).to.equal('true')
    expect(third.body.execution).to.equal(2)
    expect(counterRef.count).to.equal(2)
  })
})
