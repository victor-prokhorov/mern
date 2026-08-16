import bcrypt from 'bcrypt'
import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Cart from '../src/models/cart.js'
import Product from '../src/models/product.js'
import User from '../src/models/user.js'
import Session from '../src/models/session.js'
import { seedUser, seedUsers } from '../src/seed.js'
import { normalizeEmail, blockUser, unblockUser } from '../src/services/blocks.js'
import { hashRefreshToken } from '../src/session/tokens.js'
import { useTestDb, loginAs } from './helpers.js'

use(chaiHttp)

process.env.ADMIN_TOKEN = 'test-admin-token'

const customer = { name: 'Ada', email: 'ada@shop.test', address: '1 Main Street' }

async function setUpCart() {
  const mug = await Product.create({ name: 'Mug', price: 12, stock: 3 })
  await Cart.create({ cartId: 'cart-1', items: [{ product: mug._id, qty: 1 }] })
}

describe('user blocklist', () => {
  useTestDb()

  it('normalizes plus-tags, case, and dots', () => {
    expect(normalizeEmail('Demo+spam@Shop.test')).to.equal('demo@shop.test')
    expect(normalizeEmail('  Demo@Shop.test  ')).to.equal('demo@shop.test')
    expect(normalizeEmail('de.mo+x@gmail.com')).to.equal('demo@gmail.com')
    expect(normalizeEmail('de.mo@shop.test')).to.equal('de.mo@shop.test')
  })

  it('rejects a blocked user at login with the same message as a wrong password', async () => {
    const user = await seedUsers()
    await blockUser(user._id, 'fraud')

    const wrongPassword = await request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: 'wrong' })
    const blocked = await request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: seedUser.password })

    expect(blocked).to.have.status(401)
    expect(blocked.body.error).to.equal(wrongPassword.body.error)
  })

  it('restores access after unblocking', async () => {
    const user = await seedUsers()
    await blockUser(user._id, 'fraud')
    await unblockUser(user._id)

    const res = await request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: seedUser.password })

    expect(res).to.have.status(200)
  })

  it('blocking a user revokes their active sessions', async () => {
    const user = await seedUsers()
    const session = await loginAs(app, seedUser.email, seedUser.password)

    await blockUser(user._id, 'fraud')

    const stored = await Session.findOne({ tokenHash: hashRefreshToken(session.refreshToken) })
    expect(stored.revokedAt).to.not.equal(null)
  })

  it('rejects a refresh from a blocked user with an active session', async () => {
    const user = await seedUsers()
    const session = await loginAs(app, seedUser.email, seedUser.password)
    await blockUser(user._id, 'fraud')

    const res = await request.execute(app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken })

    expect(res).to.have.status(401)
  })

  it('rejects a refresh when the account email lands on the pattern blocklist after login', async () => {
    await seedUsers()
    const session = await loginAs(app, seedUser.email, seedUser.password)
    await request.execute(app).post('/api/blocks').set('x-admin-token', 'test-admin-token').send({ type: 'email', value: seedUser.email, reason: 'known fraud' })

    const res = await request.execute(app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken })

    expect(res).to.have.status(401)
  })

  it('rejects an order from a blocked user account', async () => {
    const user = await seedUsers()
    await setUpCart(user._id)
    const session = await loginAs(app, seedUser.email, seedUser.password)
    await blockUser(user._id, 'fraud')

    const res = await request.execute(app).post('/api/orders').set('Authorization', `Bearer ${session.accessToken}`).send({ cartId: 'cart-1', customer })

    expect(res).to.have.status(403)
    expect(res.body.error).to.equal('account is not available')
  })

  it('refuses an order when the account email domain itself is on the pattern blocklist', async () => {
    const passwordHash = await bcrypt.hash('frank-secret-passphrase', 10)
    await User.create({ name: 'Frank', email: 'frank@special-domain.test', passwordHash })
    await setUpCart()
    const session = await loginAs(app, 'frank@special-domain.test', 'frank-secret-passphrase')
    await request.execute(app).post('/api/blocks').set('x-admin-token', 'test-admin-token').send({ type: 'domain', value: 'special-domain.test', reason: 'known fraud domain' })

    const res = await request
      .execute(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ cartId: 'cart-1', customer: { name: 'Frank', email: 'someone-else@shop.test', address: '1 Main Street' } })

    expect(res).to.have.status(403)
    expect(res.body.error).to.equal('account is not available')
  })

  it('refuses an order when the account email itself is on the pattern blocklist, even with a different checkout email', async () => {
    await seedUsers()
    await setUpCart()
    const session = await loginAs(app, seedUser.email, seedUser.password)
    await request.execute(app).post('/api/blocks').set('x-admin-token', 'test-admin-token').send({ type: 'email', value: seedUser.email, reason: 'known fraud' })

    const res = await request
      .execute(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ cartId: 'cart-1', customer: { name: 'Eve', email: 'someone-else@shop.test', address: '1 Main Street' } })

    expect(res).to.have.status(403)
    expect(res.body.error).to.equal('account is not available')
  })

  it('leaves the cart intact when an order is refused for a blocked account', async () => {
    const user = await seedUsers()
    await setUpCart(user._id)
    const session = await loginAs(app, seedUser.email, seedUser.password)
    await blockUser(user._id, 'fraud')

    await request.execute(app).post('/api/orders').set('Authorization', `Bearer ${session.accessToken}`).send({ cartId: 'cart-1', customer })

    const cart = await Cart.findOne({ cartId: 'cart-1' })
    expect(cart.items).to.have.length(1)
  })

  it('creates and removes a block entry through the admin surface', async () => {
    const created = await request.execute(app).post('/api/blocks').set('x-admin-token', 'test-admin-token').send({ type: 'email', value: 'spammer@shop.test', reason: 'chargeback' })

    expect(created).to.have.status(201)
    expect(created.body.createdBy).to.equal('admin')

    const removed = await request.execute(app).delete(`/api/blocks/${created.body._id}`).set('x-admin-token', 'test-admin-token')

    expect(removed).to.have.status(204)
  })

  it('rejects the admin surface with a missing or wrong token', async () => {
    const missing = await request.execute(app).post('/api/blocks').send({ type: 'email', value: 'x@shop.test', reason: 'r' })
    const wrong = await request.execute(app).post('/api/blocks').set('x-admin-token', 'nope').send({ type: 'email', value: 'x@shop.test', reason: 'r' })

    expect(missing).to.have.status(401)
    expect(wrong).to.have.status(401)
  })
})
