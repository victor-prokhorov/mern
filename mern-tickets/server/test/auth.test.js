import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import { password, seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

describe('POST /api/auth/login', () => {
  useTestDb()

  it('returns the user without the password hash', async () => {
    const [admin] = await seedUsers()

    const res = await request.execute(app).post('/api/auth/login').send({ email: admin.email, password })

    expect(res).to.have.status(200)
    expect(res.body.email).to.equal(admin.email)
    expect(res.body.role).to.equal('admin')
    expect(res.body._id).to.be.a('string')
    expect(res.body).to.not.have.property('passwordHash')
  })

  it('rejects a wrong password', async () => {
    const [admin] = await seedUsers()

    const res = await request.execute(app).post('/api/auth/login').send({ email: admin.email, password: 'wrong' })

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('invalid credentials')
  })

  it('rejects an unknown email', async () => {
    await seedUsers()

    const res = await request.execute(app).post('/api/auth/login').send({ email: 'nobody@tickets.test', password })

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('invalid credentials')
  })

  it('rejects a request missing credentials', async () => {
    const [admin] = await seedUsers()

    const res = await request.execute(app).post('/api/auth/login').send({ email: admin.email })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('email and password are required')
  })
})
