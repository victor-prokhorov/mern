import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Cart from '../src/models/cart.js'
import Product from '../src/models/product.js'
import { seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

const customer = { name: 'Ada', email: 'ada@shop.test', address: '1 Main Street' }

async function setUpCart() {
  const user = await seedUsers()
  const mug = await Product.create({ name: 'Mug', price: 12, stock: 3 })
  const poster = await Product.create({ name: 'Poster', price: 20, stock: 5 })
  await Cart.create({ cartId: 'cart-1', items: [{ product: mug._id, qty: 2 }, { product: poster._id, qty: 1 }] })
  return { user, mug, poster }
}

describe('orders', () => {
  useTestDb()

  it('creates an order priced from the database', async () => {
    const { user } = await setUpCart()

    const res = await request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer })

    expect(res).to.have.status(201)
    expect(res.body.total).to.equal(44)
    expect(res.body.items).to.have.length(2)
    expect(res.body.items[0].name).to.equal('Mug')
    expect(res.body.items[0].price).to.equal(12)
    expect(res.body.status).to.equal('pending')
  })

  it('ignores prices sent by the client', async () => {
    const { user } = await setUpCart()

    const res = await request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer, total: 1 })

    expect(res.body.total).to.equal(44)
  })

  it('empties the cart', async () => {
    const { user } = await setUpCart()

    await request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer })

    const cart = await Cart.findOne({ cartId: 'cart-1' })
    expect(cart.items).to.have.length(0)
  })

  it('rejects an empty cart', async () => {
    const { user } = await setUpCart()
    await Cart.updateOne({ cartId: 'cart-1' }, { items: [] })

    const res = await request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('cart is empty')
  })

  it('rejects an unknown user', async () => {
    await setUpCart()

    const res = await request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: '64b7f0f0f0f0f0f0f0f0f0f0', customer })

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('user not found')
  })

  it('rejects a missing customer address', async () => {
    const { user } = await setUpCart()

    const res = await request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer: { name: 'Ada', email: 'ada@shop.test' } })

    expect(res).to.have.status(400)
  })

  it('returns a stored order', async () => {
    const { user } = await setUpCart()
    const created = await request.execute(app).post('/api/orders').send({ cartId: 'cart-1', userId: user._id.toString(), customer })

    const res = await request.execute(app).get(`/api/orders/${created.body._id}`)

    expect(res).to.have.status(200)
    expect(res.body.total).to.equal(44)
  })

  it('returns 404 for an unknown order', async () => {
    const res = await request.execute(app).get('/api/orders/64b7f0f0f0f0f0f0f0f0f0f0')

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('order not found')
  })
})
