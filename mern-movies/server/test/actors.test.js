import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Actor from '../src/models/actor.js'
import User from '../src/models/user.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

async function createUser(role = 'user') {
  return User.create({ name: 'Test User', email: `${role}-${Date.now()}-${Math.random()}@movies.test`, passwordHash: 'x', role })
}

describe('GET /api/actors', () => {
  useTestDb()

  it('returns every stored actor', async () => {
    await Actor.create({ name: 'Keanu Reeves' })
    await Actor.create({ name: 'Scarlett Johansson' })

    const res = await request.execute(app).get('/api/actors')

    expect(res).to.have.status(200)
    expect(res.body).to.have.length(2)
  })
})

describe('POST /api/actors', () => {
  useTestDb()

  it('creates an actor as admin', async () => {
    const admin = await createUser('admin')

    const res = await request.execute(app).post('/api/actors').set('x-user-id', admin._id.toString()).send({ name: 'Keanu Reeves' })

    expect(res).to.have.status(201)
    expect(res.body.name).to.equal('Keanu Reeves')
  })

  it('rejects creation for a normal user', async () => {
    const user = await createUser('user')

    const res = await request.execute(app).post('/api/actors').set('x-user-id', user._id.toString()).send({ name: 'Keanu Reeves' })

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('admin only')
  })
})
