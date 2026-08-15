import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Product from '../src/models/product.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

describe('GET /api/products', () => {
  useTestDb()

  it('returns an empty array when there are no products', async () => {
    const res = await request.execute(app).get('/api/products')

    expect(res).to.have.status(200)
    expect(res.body).to.deep.equal([])
  })

  it('returns every stored product', async () => {
    await Product.create({ name: 'Mug', price: 12, stock: 3 })
    await Product.create({ name: 'Poster', price: 20, stock: 5 })

    const res = await request.execute(app).get('/api/products')

    expect(res).to.have.status(200)
    expect(res.body).to.have.length(2)
    expect(res.body.map((p) => p.name).sort()).to.deep.equal(['Mug', 'Poster'])
  })
})

describe('GET /api/products/:id', () => {
  useTestDb()

  it('returns the product', async () => {
    const created = await Product.create({ name: 'Mug', price: 12, stock: 3 })

    const res = await request.execute(app).get(`/api/products/${created._id}`)

    expect(res).to.have.status(200)
    expect(res.body.name).to.equal('Mug')
    expect(res.body.price).to.equal(12)
  })

  it('returns 404 for an unknown but well formed id', async () => {
    const unknownId = '64b7f0f0f0f0f0f0f0f0f0f0'

    const res = await request.execute(app).get(`/api/products/${unknownId}`)

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('product not found')
  })

  it('returns 400 for a malformed id', async () => {
    const res = await request.execute(app).get('/api/products/not-an-id')

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('invalid product id')
  })
})
