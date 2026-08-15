import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Movie from '../src/models/movie.js'
import Rating from '../src/models/rating.js'
import User from '../src/models/user.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

async function createUser() {
  return User.create({ name: 'Test User', email: `user-${Date.now()}-${Math.random()}@movies.test`, passwordHash: 'x', role: 'user' })
}

describe('POST /api/ratings', () => {
  useTestDb()

  it('creates a rating', async () => {
    const user = await createUser()
    const movie = await Movie.create({ title: 'Neon Horizon', genres: ['scifi'], averageRating: 8, releasedAt: new Date('2023-01-01') })

    const res = await request.execute(app).post('/api/ratings').set('x-user-id', user._id.toString()).send({ movieId: movie._id.toString(), value: 8 })

    expect(res).to.have.status(201)
    expect(res.body.value).to.equal(8)
  })

  it('upserts rather than duplicates when the same user rates the same movie twice', async () => {
    const user = await createUser()
    const movie = await Movie.create({ title: 'Neon Horizon', genres: ['scifi'], averageRating: 8, releasedAt: new Date('2023-01-01') })
    await request.execute(app).post('/api/ratings').set('x-user-id', user._id.toString()).send({ movieId: movie._id.toString(), value: 6 })

    const res = await request.execute(app).post('/api/ratings').set('x-user-id', user._id.toString()).send({ movieId: movie._id.toString(), value: 9 })

    expect(res).to.have.status(201)
    expect(res.body.value).to.equal(9)
    const stored = await Rating.find({ user: user._id, movie: movie._id })
    expect(stored).to.have.length(1)
    expect(stored[0].value).to.equal(9)
  })

  it('rejects a value outside 1..10', async () => {
    const user = await createUser()
    const movie = await Movie.create({ title: 'Neon Horizon', genres: ['scifi'], averageRating: 8, releasedAt: new Date('2023-01-01') })

    const res = await request.execute(app).post('/api/ratings').set('x-user-id', user._id.toString()).send({ movieId: movie._id.toString(), value: 11 })

    expect(res).to.have.status(400)
  })

  it('enforces the unique index on { user, movie } at the database level', async () => {
    const user = await createUser()
    const movie = await Movie.create({ title: 'Neon Horizon', genres: ['scifi'], averageRating: 8, releasedAt: new Date('2023-01-01') })
    await Rating.create({ user: user._id, movie: movie._id, value: 5 })

    let error = null
    try {
      await Rating.collection.insertOne({ user: user._id, movie: movie._id, value: 7, createdAt: new Date() })
    } catch (err) {
      error = err
    }

    expect(error).to.not.equal(null)
    expect(error.code).to.equal(11000)
  })
})
