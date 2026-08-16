import bcrypt from 'bcrypt'
import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import { seedUser, seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

describe('POST /api/auth/login', () => {
  useTestDb()

  it('returns the user without the password hash', async () => {
    await seedUsers()

    const res = await request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: seedUser.password })

    expect(res).to.have.status(200)
    expect(res.body.user.email).to.equal(seedUser.email)
    expect(res.body.user.name).to.equal(seedUser.name)
    expect(res.body.user._id).to.be.a('string')
    expect(res.body.user).to.not.have.property('passwordHash')
    expect(res.body.accessToken).to.be.a('string')
    expect(res.body.refreshToken).to.be.a('string')
  })

  it('rejects a wrong password', async () => {
    await seedUsers()

    const res = await request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: 'wrong' })

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('invalid credentials')
  })

  it('rejects an unknown email', async () => {
    await seedUsers()

    const res = await request.execute(app).post('/api/auth/login').send({ email: 'nobody@shop.test', password: seedUser.password })

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('invalid credentials')
  })

  it('runs one bcrypt comparison for an unknown email, same as for a known one, with the identical error', async () => {
    await seedUsers()
    const originalCompare = bcrypt.compare
    let compareCalls = 0
    bcrypt.compare = (...args) => {
      compareCalls += 1
      return originalCompare.apply(bcrypt, args)
    }

    let res
    try {
      res = await request.execute(app).post('/api/auth/login').send({ email: 'nobody@shop.test', password: 'whatever-password' })
    } finally {
      bcrypt.compare = originalCompare
    }

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('invalid credentials')
    expect(compareCalls).to.equal(1)
  })

  it('rejects a request missing credentials', async () => {
    await seedUsers()

    const res = await request.execute(app).post('/api/auth/login').send({ email: seedUser.email })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('email and password are required')
  })
})
