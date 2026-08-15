import { expect } from 'chai'
import Product from '../src/models/product.js'
import { products, seedProducts } from '../src/seed.js'
import { useTestDb } from './helpers.js'

describe('seedProducts', () => {
  useTestDb()

  it('inserts every seed product', async () => {
    await seedProducts()

    const stored = await Product.find({})

    expect(stored).to.have.length(products.length)
    expect(products).to.have.length(8)
  })

  it('is idempotent', async () => {
    await seedProducts()

    await seedProducts()

    const stored = await Product.find({})
    expect(stored).to.have.length(products.length)
  })
})
