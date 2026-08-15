import { expect } from 'chai'
import Product from '../src/models/product.js'
import User from '../src/models/user.js'
import { products, seedProducts, seedUser, seedUsers } from '../src/seed.js'
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

describe('seedUsers', () => {
  useTestDb()

  it('creates one user whose password is hashed', async () => {
    await seedUsers()

    const stored = await User.find({})

    expect(stored).to.have.length(1)
    expect(stored[0].email).to.equal(seedUser.email)
    expect(stored[0].passwordHash).to.not.equal(seedUser.password)
    expect(stored[0].passwordHash).to.have.length.greaterThan(20)
  })
})
