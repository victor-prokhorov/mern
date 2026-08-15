import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Actor from '../src/models/actor.js'
import Movie from '../src/models/movie.js'
import User from '../src/models/user.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

async function createUser(role = 'user') {
  return User.create({ name: 'Test User', email: `${role}-${Date.now()}-${Math.random()}@movies.test`, passwordHash: 'x', role })
}

describe('GET /api/movies', () => {
  useTestDb()

  it('returns an empty array when there are no movies', async () => {
    const res = await request.execute(app).get('/api/movies')

    expect(res).to.have.status(200)
    expect(res.body).to.deep.equal([])
  })

  it('returns every stored movie', async () => {
    await Movie.create({ title: 'Neon Horizon', genres: ['scifi'], averageRating: 8, releasedAt: new Date('2023-01-01') })
    await Movie.create({ title: 'Quiet Harbor', genres: ['drama'], averageRating: 7, releasedAt: new Date('2022-01-01') })

    const res = await request.execute(app).get('/api/movies')

    expect(res).to.have.status(200)
    expect(res.body).to.have.length(2)
  })

  it('filters by genre', async () => {
    await Movie.create({ title: 'Neon Horizon', genres: ['scifi'], averageRating: 8, releasedAt: new Date('2023-01-01') })
    await Movie.create({ title: 'Quiet Harbor', genres: ['drama'], averageRating: 7, releasedAt: new Date('2022-01-01') })

    const res = await request.execute(app).get('/api/movies?genre=drama')

    expect(res.body).to.have.length(1)
    expect(res.body[0].title).to.equal('Quiet Harbor')
  })
})

describe('GET /api/movies/:id', () => {
  useTestDb()

  it('returns the movie', async () => {
    const created = await Movie.create({ title: 'Neon Horizon', genres: ['scifi'], averageRating: 8, releasedAt: new Date('2023-01-01') })

    const res = await request.execute(app).get(`/api/movies/${created._id}`)

    expect(res).to.have.status(200)
    expect(res.body.title).to.equal('Neon Horizon')
  })

  it('returns 404 for an unknown but well formed id', async () => {
    const unknownId = '64b7f0f0f0f0f0f0f0f0f0f0'

    const res = await request.execute(app).get(`/api/movies/${unknownId}`)

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('movie not found')
  })

  it('returns 400 for a malformed id', async () => {
    const res = await request.execute(app).get('/api/movies/not-an-id')

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('invalid movie id')
  })
})

describe('POST /api/movies', () => {
  useTestDb()

  it('creates a movie with cast as admin', async () => {
    const admin = await createUser('admin')
    const actor = await Actor.create({ name: 'Keanu Reeves' })

    const res = await request
      .execute(app)
      .post('/api/movies')
      .set('x-user-id', admin._id.toString())
      .send({ title: 'Neon Horizon', genres: ['scifi'], cast: [actor._id.toString()], averageRating: 8, releasedAt: '2023-01-01' })

    expect(res).to.have.status(201)
    expect(res.body.title).to.equal('Neon Horizon')
    expect(res.body.cast).to.deep.equal([actor._id.toString()])
  })

  it('rejects creation for a normal user', async () => {
    const user = await createUser('user')
    const actor = await Actor.create({ name: 'Keanu Reeves' })

    const res = await request
      .execute(app)
      .post('/api/movies')
      .set('x-user-id', user._id.toString())
      .send({ title: 'Neon Horizon', genres: ['scifi'], cast: [actor._id.toString()], averageRating: 8, releasedAt: '2023-01-01' })

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('admin only')
  })

  it('rejects creation without an x-user-id header', async () => {
    const res = await request.execute(app).post('/api/movies').send({ title: 'Neon Horizon', genres: ['scifi'], averageRating: 8, releasedAt: '2023-01-01' })

    expect(res).to.have.status(401)
  })
})
