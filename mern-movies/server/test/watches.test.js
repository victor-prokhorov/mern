import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Movie from '../src/models/movie.js'
import User from '../src/models/user.js'
import Watch from '../src/models/watch.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

async function createUser() {
  return User.create({ name: 'Test User', email: `user-${Date.now()}-${Math.random()}@movies.test`, passwordHash: 'x', role: 'user' })
}

describe('POST /api/watches', () => {
  useTestDb()

  it('creates a watch', async () => {
    const user = await createUser()
    const movie = await Movie.create({ title: 'Neon Horizon', genres: ['scifi'], averageRating: 8, releasedAt: new Date('2023-01-01') })

    const res = await request.execute(app).post('/api/watches').set('x-user-id', user._id.toString()).send({ movieId: movie._id.toString() })

    expect(res).to.have.status(201)
    expect(res.body.movie).to.equal(movie._id.toString())
  })

  it('does not duplicate when watched twice', async () => {
    const user = await createUser()
    const movie = await Movie.create({ title: 'Neon Horizon', genres: ['scifi'], averageRating: 8, releasedAt: new Date('2023-01-01') })
    await request.execute(app).post('/api/watches').set('x-user-id', user._id.toString()).send({ movieId: movie._id.toString() })

    await request.execute(app).post('/api/watches').set('x-user-id', user._id.toString()).send({ movieId: movie._id.toString() })

    const stored = await Watch.find({ user: user._id, movie: movie._id })
    expect(stored).to.have.length(1)
  })

  it('enforces the unique index on { user, movie } at the database level', async () => {
    const user = await createUser()
    const movie = await Movie.create({ title: 'Neon Horizon', genres: ['scifi'], averageRating: 8, releasedAt: new Date('2023-01-01') })
    await Watch.create({ user: user._id, movie: movie._id })

    let error = null
    try {
      await Watch.collection.insertOne({ user: user._id, movie: movie._id, watchedAt: new Date() })
    } catch (err) {
      error = err
    }

    expect(error).to.not.equal(null)
    expect(error.code).to.equal(11000)
  })
})
