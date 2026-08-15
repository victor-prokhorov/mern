import { expect, use } from 'chai'
import chaiHttp from 'chai-http'
import app from '../src/app.js'
import Product from '../src/models/product.js'
import { useTestDb } from './helpers.js'

const chai = use(chaiHttp)

describe('GET /api/products', () => {
  useTestDb()

  it('returns an empty array when there are no products', async () => {
    const res = await chai.request.execute(app).get('/api/products')

    expect(res).to.have.status(200)
    expect(res.body).to.deep.equal([])
  })

  it('returns every stored product', async () => {
    await Product.create({ name: 'Mug', price: 12, stock: 3 })
    await Product.create({ name: 'Poster', price: 20, stock: 5 })

    const res = await chai.request.execute(app).get('/api/products')

    expect(res).to.have.status(200)
    expect(res.body).to.have.length(2)
    expect(res.body.map((p) => p.name).sort()).to.deep.equal(['Mug', 'Poster'])
  })
})
