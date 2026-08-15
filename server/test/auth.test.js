import { expect, use } from 'chai'
import chaiHttp from 'chai-http'
import app from '../src/app.js'
import { seedUser, seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

const chai = use(chaiHttp)

describe('POST /api/auth/login', () => {
  useTestDb()

  it('returns the user without the password hash', async () => {
    await seedUsers()

    const res = await chai.request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: seedUser.password })

    expect(res).to.have.status(200)
    expect(res.body.email).to.equal(seedUser.email)
    expect(res.body.name).to.equal(seedUser.name)
    expect(res.body._id).to.be.a('string')
    expect(res.body).to.not.have.property('passwordHash')
  })

  it('rejects a wrong password', async () => {
    await seedUsers()

    const res = await chai.request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: 'wrong' })

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('invalid credentials')
  })

  it('rejects an unknown email', async () => {
    await seedUsers()

    const res = await chai.request.execute(app).post('/api/auth/login').send({ email: 'nobody@shop.test', password: seedUser.password })

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('invalid credentials')
  })

  it('rejects a request missing credentials', async () => {
    await seedUsers()

    const res = await chai.request.execute(app).post('/api/auth/login').send({ email: seedUser.email })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('email and password are required')
  })
})
