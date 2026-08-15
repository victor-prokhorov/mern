import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import { rank } from '../src/recommendations/rank.js'
import app from '../src/app.js'
import Movie from '../src/models/movie.js'
import Rating from '../src/models/rating.js'
import User from '../src/models/user.js'
import Watch from '../src/models/watch.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

function movie(id, genres, averageRating) {
  return { _id: id, genres, averageRating }
}

describe('rank', () => {
  it('boosts a candidate sharing a liked genre by 1.2', () => {
    const candidates = [movie('a', ['thriller'], 7), movie('b', ['comedy'], 7)]
    const signals = { likedGenres: ['thriller'], dislikedGenres: [], watchedGenres: [] }

    const result = rank(candidates, signals)

    expect(result[0].movie._id).to.equal('a')
    expect(result[0].score).to.equal(8.4)
    expect(result[0].reasons).to.deep.equal(['LIKED_GENRE:thriller'])
  })

  it('demotes a candidate sharing a disliked genre by 0.8 without excluding it', () => {
    const candidates = [movie('a', ['comedy'], 7)]
    const signals = { likedGenres: [], dislikedGenres: ['comedy'], watchedGenres: [] }

    const result = rank(candidates, signals)

    expect(result).to.have.length(1)
    expect(result[0].score).to.be.closeTo(5.6, 1e-9)
    expect(result[0].reasons).to.deep.equal(['DISLIKED_GENRE:comedy'])
  })

  it('boosts a candidate sharing a watched-unrated genre by 1.1', () => {
    const candidates = [movie('a', ['drama'], 7), movie('b', ['comedy'], 7)]
    const signals = { likedGenres: [], dislikedGenres: [], watchedGenres: ['drama'] }

    const result = rank(candidates, signals)

    expect(result[0].movie._id).to.equal('a')
    expect(result[0].score).to.be.closeTo(7.7, 1e-9)
    expect(result[0].reasons).to.deep.equal(['WATCHED_GENRE:drama'])
  })

  it('composes multipliers when a genre is both liked and watched-unrated', () => {
    const candidates = [movie('a', ['thriller'], 7)]
    const signals = { likedGenres: ['thriller'], dislikedGenres: [], watchedGenres: ['thriller'] }

    const result = rank(candidates, signals)

    expect(result[0].score).to.be.closeTo(7 * 1.2 * 1.1, 1e-9)
    expect(result[0].reasons).to.deep.equal(['LIKED_GENRE:thriller', 'WATCHED_GENRE:thriller'])
  })

  it('composes liked and disliked multipliers near neutral when a genre is both', () => {
    const candidates = [movie('a', ['thriller'], 7)]
    const signals = { likedGenres: ['thriller'], dislikedGenres: ['thriller'], watchedGenres: [] }

    const result = rank(candidates, signals)

    expect(result[0].score).to.be.closeTo(7 * 1.2 * 0.8, 1e-9)
    expect(result[0].reasons).to.deep.equal(['LIKED_GENRE:thriller', 'DISLIKED_GENRE:thriller'])
  })

  it('returns at most 10 results', () => {
    const candidates = Array.from({ length: 15 }, (_, i) => movie(`m${i}`, ['drama'], 7 + i * 0.01))
    const signals = { likedGenres: [], dislikedGenres: [], watchedGenres: [] }

    const result = rank(candidates, signals)

    expect(result).to.have.length(10)
  })

  it('returns fewer than 10 when the pool is smaller', () => {
    const candidates = [movie('a', ['drama'], 7), movie('b', ['comedy'], 7)]
    const signals = { likedGenres: [], dislikedGenres: [], watchedGenres: [] }

    const result = rank(candidates, signals)

    expect(result).to.have.length(2)
  })

  it('breaks ties deterministically by ascending _id', () => {
    const candidates = [movie('b', ['drama'], 7), movie('a', ['drama'], 7)]
    const signals = { likedGenres: [], dislikedGenres: [], watchedGenres: [] }

    const result = rank(candidates, signals)

    expect(result.map((entry) => entry.movie._id)).to.deep.equal(['a', 'b'])
  })

  it('is deterministic across two calls', () => {
    const candidates = Array.from({ length: 12 }, (_, i) => movie(`m${i}`, i % 2 === 0 ? ['drama'] : ['comedy'], 7 + (i % 3) * 0.1))
    const signals = { likedGenres: ['drama'], dislikedGenres: ['comedy'], watchedGenres: [] }

    const first = rank(candidates, signals)
    const second = rank(candidates, signals)

    expect(first.map((entry) => entry.movie._id)).to.deep.equal(second.map((entry) => entry.movie._id))
    expect(first.map((entry) => entry.score)).to.deep.equal(second.map((entry) => entry.score))
  })
})

describe('GET /api/recommendations', () => {
  useTestDb()

  async function createUser(role = 'user') {
    return User.create({ name: 'Test User', email: `user-${Date.now()}-${Math.random()}@movies.test`, passwordHash: 'x', role })
  }

  it('excludes movies the user has rated or watched', async () => {
    const user = await createUser()
    const rated = await Movie.create({ title: 'Rated', genres: ['drama'], averageRating: 9, releasedAt: new Date('2020-01-01') })
    const watched = await Movie.create({ title: 'Watched', genres: ['drama'], averageRating: 9, releasedAt: new Date('2020-01-01') })
    const eligible = await Movie.create({ title: 'Eligible', genres: ['drama'], averageRating: 9, releasedAt: new Date('2020-01-01') })
    await Rating.create({ user: user._id, movie: rated._id, value: 8 })
    await Watch.create({ user: user._id, movie: watched._id })

    const res = await request.execute(app).get('/api/recommendations').set('x-user-id', user._id.toString())

    expect(res).to.have.status(200)
    const ids = res.body.map((entry) => entry.movie._id)
    expect(ids).to.not.include(rated._id.toString())
    expect(ids).to.not.include(watched._id.toString())
    expect(ids).to.include(eligible._id.toString())
  })

  it('only returns movies with averageRating >= 7 and the mean of the results is >= 7', async () => {
    const user = await createUser()
    await Movie.create({ title: 'Low', genres: ['drama'], averageRating: 5, releasedAt: new Date('2020-01-01') })
    await Movie.create({ title: 'High 1', genres: ['drama'], averageRating: 8, releasedAt: new Date('2020-01-01') })
    await Movie.create({ title: 'High 2', genres: ['drama'], averageRating: 9, releasedAt: new Date('2020-01-01') })

    const res = await request.execute(app).get('/api/recommendations').set('x-user-id', user._id.toString())

    expect(res).to.have.status(200)
    expect(res.body.every((entry) => entry.movie.averageRating >= 7)).to.equal(true)
    const mean = res.body.reduce((sum, entry) => sum + entry.movie.averageRating, 0) / res.body.length
    expect(mean).to.be.at.least(7)
  })

  it('gives a user with no history the top-rated eligible movies', async () => {
    const user = await createUser()
    await Movie.create({ title: 'Top', genres: ['drama'], averageRating: 9, releasedAt: new Date('2020-01-01') })
    await Movie.create({ title: 'Mid', genres: ['drama'], averageRating: 7.5, releasedAt: new Date('2020-01-01') })

    const res = await request.execute(app).get('/api/recommendations').set('x-user-id', user._id.toString())

    expect(res.body[0].movie.title).to.equal('Top')
  })

  it('returns exactly 10 when at least 10 candidates are eligible', async () => {
    const user = await createUser()
    await Promise.all(Array.from({ length: 12 }, (_, i) => Movie.create({ title: `Movie ${i}`, genres: ['drama'], averageRating: 7 + i * 0.1, releasedAt: new Date('2020-01-01') })))

    const res = await request.execute(app).get('/api/recommendations').set('x-user-id', user._id.toString())

    expect(res.body).to.have.length(10)
  })

  it('is deterministic across two calls', async () => {
    const user = await createUser()
    await Promise.all(Array.from({ length: 12 }, (_, i) => Movie.create({ title: `Movie ${i}`, genres: ['drama'], averageRating: 7 + (i % 3) * 0.1, releasedAt: new Date('2020-01-01') })))

    const first = await request.execute(app).get('/api/recommendations').set('x-user-id', user._id.toString())
    const second = await request.execute(app).get('/api/recommendations').set('x-user-id', user._id.toString())

    expect(first.body.map((entry) => entry.movie._id)).to.deep.equal(second.body.map((entry) => entry.movie._id))
  })

  it('lets a disliked-genre movie appear when nothing else is eligible', async () => {
    const user = await createUser()
    const dislikedSource = await Movie.create({ title: 'Comedy Seed', genres: ['comedy'], averageRating: 8, releasedAt: new Date('2020-01-01') })
    await Rating.create({ user: user._id, movie: dislikedSource._id, value: 3 })
    const onlyEligible = await Movie.create({ title: 'Only Option', genres: ['comedy'], averageRating: 7.5, releasedAt: new Date('2020-01-01') })

    const res = await request.execute(app).get('/api/recommendations').set('x-user-id', user._id.toString())

    const ids = res.body.map((entry) => entry.movie._id)
    expect(ids).to.include(onlyEligible._id.toString())
  })

  it('carries accurate reason codes', async () => {
    const user = await createUser()
    const likedSource = await Movie.create({ title: 'Liked Seed', genres: ['thriller'], averageRating: 8, releasedAt: new Date('2020-01-01') })
    await Rating.create({ user: user._id, movie: likedSource._id, value: 8 })
    await Movie.create({ title: 'Thriller Candidate', genres: ['thriller'], averageRating: 7.5, releasedAt: new Date('2020-01-01') })

    const res = await request.execute(app).get('/api/recommendations').set('x-user-id', user._id.toString())

    const candidate = res.body.find((entry) => entry.movie.title === 'Thriller Candidate')
    expect(candidate.reasons).to.deep.equal(['LIKED_GENRE:thriller'])
  })

  it('carries a WATCHED_GENRE reason for a genre that was watched but never rated', async () => {
    const user = await createUser()
    const watchedSource = await Movie.create({ title: 'Watched Seed', genres: ['horror'], averageRating: 8, releasedAt: new Date('2020-01-01') })
    await Watch.create({ user: user._id, movie: watchedSource._id })
    await Movie.create({ title: 'Horror Candidate', genres: ['horror'], averageRating: 7.5, releasedAt: new Date('2020-01-01') })

    const res = await request.execute(app).get('/api/recommendations').set('x-user-id', user._id.toString())

    const candidate = res.body.find((entry) => entry.movie.title === 'Horror Candidate')
    expect(candidate.reasons).to.deep.equal(['WATCHED_GENRE:horror'])
  })

  it('carries a DISLIKED_GENRE reason for a genre rated 5 or below', async () => {
    const user = await createUser()
    const dislikedSource = await Movie.create({ title: 'Disliked Seed', genres: ['comedy'], averageRating: 8, releasedAt: new Date('2020-01-01') })
    await Rating.create({ user: user._id, movie: dislikedSource._id, value: 5 })
    await Movie.create({ title: 'Comedy Candidate', genres: ['comedy'], averageRating: 7.5, releasedAt: new Date('2020-01-01') })

    const res = await request.execute(app).get('/api/recommendations').set('x-user-id', user._id.toString())

    const candidate = res.body.find((entry) => entry.movie.title === 'Comedy Candidate')
    expect(candidate.reasons).to.deep.equal(['DISLIKED_GENRE:comedy'])
  })

  it('does not carry a WATCHED_GENRE reason for a genre that was watched but also rated', async () => {
    const user = await createUser()
    const watchedAndRated = await Movie.create({ title: 'Watched And Rated', genres: ['drama'], averageRating: 8, releasedAt: new Date('2020-01-01') })
    await Watch.create({ user: user._id, movie: watchedAndRated._id })
    await Rating.create({ user: user._id, movie: watchedAndRated._id, value: 8 })
    await Movie.create({ title: 'Drama Candidate', genres: ['drama'], averageRating: 7.5, releasedAt: new Date('2020-01-01') })

    const res = await request.execute(app).get('/api/recommendations').set('x-user-id', user._id.toString())

    const candidate = res.body.find((entry) => entry.movie.title === 'Drama Candidate')
    expect(candidate.reasons).to.deep.equal(['LIKED_GENRE:drama'])
  })
})
