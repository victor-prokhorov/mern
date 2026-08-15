import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Product from '../src/models/product.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

describe('cart', () => {
  useTestDb()

  it('returns an empty cart for an unknown cart id', async () => {
    const res = await request.execute(app).get('/api/cart/cart-1')

    expect(res).to.have.status(200)
    expect(res.body.cartId).to.equal('cart-1')
    expect(res.body.items).to.deep.equal([])
  })

  it('adds an item and returns it populated', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })

    const res = await request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 2 })

    expect(res).to.have.status(200)
    expect(res.body.items).to.have.length(1)
    expect(res.body.items[0].qty).to.equal(2)
    expect(res.body.items[0].product.name).to.equal('Mug')
  })

  it('merges quantity when the same product is added twice', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })
    await request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 2 })

    const res = await request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 3 })

    expect(res.body.items).to.have.length(1)
    expect(res.body.items[0].qty).to.equal(5)
  })

  it('rejects adding an unknown product', async () => {
    const res = await request.execute(app).post('/api/cart/cart-1/items').send({ productId: '64b7f0f0f0f0f0f0f0f0f0f0', qty: 1 })

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('product not found')
  })

  it('rejects a quantity below one', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })

    const res = await request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 0 })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('qty must be a positive integer')
  })

  it('updates the quantity of an item', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })
    await request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 2 })

    const res = await request.execute(app).patch(`/api/cart/cart-1/items/${product._id}`).send({ qty: 7 })

    expect(res).to.have.status(200)
    expect(res.body.items[0].qty).to.equal(7)
  })

  it('returns 404 when updating an item that is not in the cart', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })

    const res = await request.execute(app).patch(`/api/cart/cart-1/items/${product._id}`).send({ qty: 7 })

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('item not in cart')
  })

  it('removes an item', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })
    await request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 2 })

    const res = await request.execute(app).delete(`/api/cart/cart-1/items/${product._id}`)

    expect(res).to.have.status(200)
    expect(res.body.items).to.deep.equal([])
  })

  it('keeps carts separate', async () => {
    const product = await Product.create({ name: 'Mug', price: 12, stock: 3 })
    await request.execute(app).post('/api/cart/cart-1/items').send({ productId: product._id.toString(), qty: 2 })

    const res = await request.execute(app).get('/api/cart/cart-2')

    expect(res.body.items).to.deep.equal([])
  })
})
