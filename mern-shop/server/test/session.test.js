import express from 'express'
import jwt from 'jsonwebtoken'
import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Cart from '../src/models/cart.js'
import Product from '../src/models/product.js'
import Order from '../src/models/order.js'
import { seedUser, seedUsers } from '../src/seed.js'
import * as usersRepo from '../src/repositories/users.js'
import { requireAuth } from '../src/middleware/auth.js'
import { signAccessToken } from '../src/session/tokens.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

const customer = { name: 'Ada', email: 'ada@shop.test', address: '1 Main Street' }

function buildProtectedApp() {
  const built = express()
  built.use(express.json())
  built.get('/whoami', requireAuth, (req, res) => res.json({ userId: req.userId }))
  built.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }))
  return built
}

async function login(email, password) {
  return request.execute(app).post('/api/auth/login').send({ email, password })
}

async function setUpCart(cartId = 'cart-1') {
  await seedUsers()
  const mug = await Product.create({ name: 'Mug', price: 12, stock: 3 })
  await Cart.create({ cartId, items: [{ product: mug._id, qty: 1 }] })
}

describe('sessions', () => {
  useTestDb()

  it('login returns an access token and a refresh token, and the refresh token is not stored in plaintext', async () => {
    await seedUsers()

    const res = await login(seedUser.email, seedUser.password)

    expect(res).to.have.status(200)
    expect(res.body.accessToken).to.be.a('string')
    expect(res.body.refreshToken).to.be.a('string')
    const Session = (await import('../src/models/session.js')).default
    const stored = await Session.findOne({})
    expect(stored.tokenHash).to.not.equal(res.body.refreshToken)
  })

  it('the access token authorises order placement, and a body userId for a different user is ignored', async () => {
    await setUpCart()
    const seededUser = await usersRepo.findByEmail(seedUser.email)
    const otherUser = await usersRepo.create({ name: 'Mallory', email: 'mallory@shop.test', passwordHash: 'irrelevant' })
    const loginRes = await login(seedUser.email, seedUser.password)

    const res = await request
      .execute(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
      .send({ cartId: 'cart-1', userId: otherUser._id.toString(), customer })

    expect(res).to.have.status(201)
    expect(res.body.user).to.equal(seededUser._id.toString())
  })

  it('rejects an expired access token', async () => {
    const protectedApp = buildProtectedApp()
    const expired = signAccessToken({ sub: 'user-1', sid: 'family-1' }, { expiresInSeconds: -10 })

    const res = await request.execute(protectedApp).get('/whoami').set('Authorization', `Bearer ${expired}`)

    expect(res).to.have.status(401)
  })

  it('rejects a tampered signature, and rejects alg: none', async () => {
    const protectedApp = buildProtectedApp()
    const valid = signAccessToken({ sub: 'user-1', sid: 'family-1' })
    const tampered = valid.slice(0, -2) + (valid.slice(-2) === 'aa' ? 'bb' : 'aa')
    const none = jwt.sign({ sub: 'user-1', sid: 'family-1' }, '', { algorithm: 'none' })

    const tamperedRes = await request.execute(protectedApp).get('/whoami').set('Authorization', `Bearer ${tampered}`)
    const noneRes = await request.execute(protectedApp).get('/whoami').set('Authorization', `Bearer ${none}`)

    expect(tamperedRes).to.have.status(401)
    expect(noneRes).to.have.status(401)
  })

  it('refresh rotates: the old token stops working, the new one works', async () => {
    await seedUsers()
    const loginRes = await login(seedUser.email, seedUser.password)

    const rotated = await request.execute(app).post('/api/auth/refresh').send({ refreshToken: loginRes.body.refreshToken })
    const again = await request.execute(app).post('/api/auth/refresh').send({ refreshToken: rotated.body.refreshToken })
    const replay = await request.execute(app).post('/api/auth/refresh').send({ refreshToken: loginRes.body.refreshToken })

    expect(rotated).to.have.status(200)
    expect(again).to.have.status(200)
    expect(replay).to.have.status(401)
  })

  it('reuse detection: replaying a rotated token revokes the family, and the previously valid new token stops working too', async () => {
    await seedUsers()
    const loginRes = await login(seedUser.email, seedUser.password)
    const rotated = await request.execute(app).post('/api/auth/refresh').send({ refreshToken: loginRes.body.refreshToken })

    const reused = await request.execute(app).post('/api/auth/refresh').send({ refreshToken: loginRes.body.refreshToken })
    const afterReuse = await request.execute(app).post('/api/auth/refresh').send({ refreshToken: rotated.body.refreshToken })

    expect(reused).to.have.status(401)
    expect(afterReuse).to.have.status(401)
  })

  it('logout revokes: refresh afterwards fails', async () => {
    await seedUsers()
    const loginRes = await login(seedUser.email, seedUser.password)

    const loggedOut = await request.execute(app).post('/api/auth/logout').send({ refreshToken: loginRes.body.refreshToken })
    const afterLogout = await request.execute(app).post('/api/auth/refresh').send({ refreshToken: loginRes.body.refreshToken })

    expect(loggedOut).to.have.status(200)
    expect(afterLogout).to.have.status(401)
  })

  it('a revoked family cannot be resurrected by an old access token beyond its expiry', async () => {
    const user = await seedUsers()
    const loginRes = await login(seedUser.email, seedUser.password)
    await request.execute(app).post('/api/auth/logout').send({ refreshToken: loginRes.body.refreshToken })
    const protectedApp = buildProtectedApp()
    const expiredAccessToken = signAccessToken({ sub: user._id.toString(), sid: 'whichever-family' }, { expiresInSeconds: -10 })

    const res = await request.execute(protectedApp).get('/whoami').set('Authorization', `Bearer ${expiredAccessToken}`)

    expect(res).to.have.status(401)
  })
})
