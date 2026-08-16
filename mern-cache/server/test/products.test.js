import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import { seedProducts } from '../src/seed.js'
import { resetCacheStats } from '../src/services/products.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

describe('products HTTP and cache wiring', () => {
  useTestDb()

  it('serves a cold GET from the origin, then the next GET from cache', async () => {
    const [product] = await seedProducts()
    resetCacheStats()

    const miss = await request.execute(app).get(`/api/products/${product._id}`)
    const hit = await request.execute(app).get(`/api/products/${product._id}`)

    expect(miss).to.have.status(200)
    expect(miss.headers['x-cache']).to.equal('origin')
    expect(hit.headers['x-cache']).to.equal('cache')
    expect(hit.body.name).to.equal(product.name)
  })

  it('invalidates the cache on write so the next GET reflects the update', async () => {
    const [product] = await seedProducts()
    resetCacheStats()
    await request.execute(app).get(`/api/products/${product._id}`)

    const patched = await request.execute(app).patch(`/api/products/${product._id}`).send({ priceCents: 999 })
    const afterWrite = await request.execute(app).get(`/api/products/${product._id}`)

    expect(patched).to.have.status(200)
    expect(afterWrite.headers['x-cache']).to.equal('origin')
    expect(afterWrite.body.priceCents).to.equal(999)
  })

  it('returns 404 for a missing product and caches the absence', async () => {
    await seedProducts()
    resetCacheStats()
    const ghostId = '000000000000000000000000'

    const first = await request.execute(app).get(`/api/products/${ghostId}`)
    const second = await request.execute(app).get(`/api/products/${ghostId}`)
    const stats = await request.execute(app).get('/api/cache/stats')

    expect(first).to.have.status(404)
    expect(second).to.have.status(404)
    expect(second.headers['x-cache']).to.equal('negative')
    expect(stats.body.originReads).to.equal(1)
  })

  it('rejects a malformed product id with 400', async () => {
    await seedProducts()

    const res = await request.execute(app).get('/api/products/not-an-id')

    expect(res).to.have.status(400)
  })
})
