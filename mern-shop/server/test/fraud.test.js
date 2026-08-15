import { ObjectId } from 'mongodb'
import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import User from '../src/models/user.js'
import Order from '../src/models/order.js'
import Cart from '../src/models/cart.js'
import Product from '../src/models/product.js'
import { seedUser, seedUsers } from '../src/seed.js'
import { NEW_ACCOUNT, ORDER_VELOCITY, HIGH_VALUE, QUANTITY_ANOMALY, EMAIL_MISMATCH, BLOCKED_DOMAIN, evaluateSignals } from '../src/fraud/signals.js'
import { score } from '../src/fraud/score.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token'

describe('fraud signals', () => {
  it('NEW_ACCOUNT triggers for an account younger than 24 hours', () => {
    const signal = NEW_ACCOUNT({ user: { createdAt: new Date() } })

    expect(signal).to.deep.equal({ code: 'NEW_ACCOUNT', weight: 20, triggered: true, detail: 'account is less than 24 hours old' })
  })

  it('NEW_ACCOUNT does not trigger for an older account', () => {
    const signal = NEW_ACCOUNT({ user: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } })

    expect(signal.triggered).to.equal(false)
  })

  it('ORDER_VELOCITY triggers past 3 orders in the last hour', () => {
    const signal = ORDER_VELOCITY({ stats: { recentOrderCount: 4 } })

    expect(signal.triggered).to.equal(true)
  })

  it('ORDER_VELOCITY does not trigger at exactly 3 orders', () => {
    const signal = ORDER_VELOCITY({ stats: { recentOrderCount: 3 } })

    expect(signal.triggered).to.equal(false)
  })

  it('HIGH_VALUE triggers above 200', () => {
    const signal = HIGH_VALUE({ cart: { items: [{ price: 250, qty: 1 }] } })

    expect(signal.triggered).to.equal(true)
  })

  it('HIGH_VALUE does not trigger at exactly 200', () => {
    const signal = HIGH_VALUE({ cart: { items: [{ price: 200, qty: 1 }] } })

    expect(signal.triggered).to.equal(false)
  })

  it('QUANTITY_ANOMALY triggers when a line quantity exceeds 10', () => {
    const signal = QUANTITY_ANOMALY({ cart: { items: [{ price: 5, qty: 11 }] } })

    expect(signal.triggered).to.equal(true)
  })

  it('QUANTITY_ANOMALY does not trigger at exactly 10', () => {
    const signal = QUANTITY_ANOMALY({ cart: { items: [{ price: 5, qty: 10 }] } })

    expect(signal.triggered).to.equal(false)
  })

  it('EMAIL_MISMATCH triggers when the checkout email differs from the account email', () => {
    const signal = EMAIL_MISMATCH({ user: { email: 'demo@shop.test' }, customer: { email: 'other@shop.test' } })

    expect(signal.triggered).to.equal(true)
  })

  it('EMAIL_MISMATCH does not trigger for the same normalized email', () => {
    const signal = EMAIL_MISMATCH({ user: { email: 'Demo@Shop.test' }, customer: { email: 'demo+order@shop.test' } })

    expect(signal.triggered).to.equal(false)
  })

  it('BLOCKED_DOMAIN triggers when the precomputed stats flag is set', () => {
    const signal = BLOCKED_DOMAIN({ stats: { isDomainBlocked: true } })

    expect(signal.triggered).to.equal(true)
  })

  it('BLOCKED_DOMAIN does not trigger when the precomputed stats flag is unset', () => {
    const signal = BLOCKED_DOMAIN({ stats: { isDomainBlocked: false } })

    expect(signal.triggered).to.equal(false)
  })
})

describe('fraud score', () => {
  it('scores a clean order as 0 and allow', () => {
    const context = {
      user: { email: 'demo@shop.test', createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      cart: { items: [{ price: 20, qty: 1 }] },
      customer: { email: 'demo@shop.test' },
      stats: { recentOrderCount: 0, isDomainBlocked: false }
    }

    const result = score(evaluateSignals(context))

    expect(result.score).to.equal(0)
    expect(result.decision).to.equal('allow')
    expect(result.reasons).to.deep.equal([])
  })

  it('lands a new account with a high value order in review', () => {
    const context = {
      user: { email: 'demo@shop.test', createdAt: new Date() },
      cart: { items: [{ price: 250, qty: 1 }] },
      customer: { email: 'demo@shop.test' },
      stats: { recentOrderCount: 0, isDomainBlocked: false }
    }

    const result = score(evaluateSignals(context))

    expect(result.decision).to.equal('review')
    expect(result.reasons).to.have.members(['NEW_ACCOUNT', 'HIGH_VALUE'])
  })

  it('denies an order whose combined signals cross the deny threshold', () => {
    const context = {
      user: { email: 'demo@shop.test', createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      cart: { items: [{ price: 250, qty: 11 }] },
      customer: { email: 'demo@shop.test' },
      stats: { recentOrderCount: 4, isDomainBlocked: false }
    }

    const result = score(evaluateSignals(context))

    expect(result.decision).to.equal('deny')
  })

  it('is deterministic: the same inputs always score the same order the same way', () => {
    const context = {
      user: { email: 'demo@shop.test', createdAt: new Date() },
      cart: { items: [{ price: 250, qty: 1 }] },
      customer: { email: 'other@shop.test' },
      stats: { recentOrderCount: 1, isDomainBlocked: false }
    }

    const first = score(evaluateSignals(context))
    const second = score(evaluateSignals(context))

    expect(first).to.deep.equal(second)
  })
})

describe('fraud scoring integration', () => {
  useTestDb()

  async function setUpCart(items) {
    const products = await Promise.all(items.map((item) => Product.create({ name: item.name, price: item.price, stock: 1000 })))
    await Cart.create({ cartId: 'cart-1', items: products.map((product, i) => ({ product: product._id, qty: items[i].qty })) })
  }

  it('allows a clean order and never returns the score or reasons to the client', async () => {
    const user = await seedUsers()
    await User.updateOne({ _id: user._id }, { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
    await setUpCart([{ name: 'Mug', price: 20, qty: 1 }])

    const res = await request
      .execute(app)
      .post('/api/orders')
      .send({ cartId: 'cart-1', userId: user._id.toString(), customer: { name: 'Demo', email: seedUser.email, address: '1 Main Street' } })

    expect(res).to.have.status(201)
    expect(res.body.status).to.equal('pending')
    expect(res.body).to.not.have.property('fraud')
  })

  it('creates a held-for-review order and empties the cart for a new account with a high value order', async () => {
    const user = await seedUsers()
    await setUpCart([{ name: 'Poster', price: 250, qty: 1 }])

    const res = await request
      .execute(app)
      .post('/api/orders')
      .send({ cartId: 'cart-1', userId: user._id.toString(), customer: { name: 'Demo', email: seedUser.email, address: '1 Main Street' } })

    expect(res).to.have.status(201)
    expect(res.body.status).to.equal('review')
    expect(res.body).to.not.have.property('fraud')
    const cart = await Cart.findOne({ cartId: 'cart-1' })
    expect(cart.items).to.have.length(0)
  })

  it('denies an order whose combined signals cross the deny threshold, creates no order, and leaves the cart intact', async () => {
    const user = await seedUsers()
    await User.updateOne({ _id: user._id }, { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
    const priorOrder = {
      user: user._id,
      items: [{ product: new ObjectId(), name: 'Mug', price: 12, qty: 1 }],
      total: 12,
      customer: { name: 'Demo', email: seedUser.email, address: '1 Main Street' }
    }
    await Order.create(priorOrder)
    await Order.create(priorOrder)
    await Order.create(priorOrder)
    await Order.create(priorOrder)
    await setUpCart([{ name: 'Poster', price: 250, qty: 11 }])

    const res = await request
      .execute(app)
      .post('/api/orders')
      .send({ cartId: 'cart-1', userId: user._id.toString(), customer: { name: 'Demo', email: seedUser.email, address: '1 Main Street' } })

    expect(res).to.have.status(403)
    expect(res.body.error).to.equal('order could not be completed')
    const cart = await Cart.findOne({ cartId: 'cart-1' })
    expect(cart.items).to.have.length(1)
    const orderCount = await Order.countDocuments({ user: user._id })
    expect(orderCount).to.equal(4)
  })
})
