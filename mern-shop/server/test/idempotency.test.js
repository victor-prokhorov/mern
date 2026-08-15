import bcrypt from 'bcrypt'
import express from 'express'
import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Order from '../src/models/order.js'
import Cart from '../src/models/cart.js'
import Product from '../src/models/product.js'
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
})
