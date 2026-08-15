import { expect } from 'chai'
import Actor from '../src/models/actor.js'
import Movie from '../src/models/movie.js'
import User from '../src/models/user.js'
import { actorNames, movieSeeds, seedActors, seedMovies, seedUsers, seedUsersData } from '../src/seed.js'
import { useTestDb } from './helpers.js'

describe('seedActors', () => {
  useTestDb()

  it('inserts every seed actor', async () => {
    await seedActors()

    const stored = await Actor.find({})

    expect(stored).to.have.length(actorNames.length)
    expect(actorNames.length).to.be.at.least(12)
  })
})

describe('seedMovies', () => {
  useTestDb()

  it('inserts every seed movie across at least six genres with a cast', async () => {
    const actors = await seedActors()

    await seedMovies(actors)

    const stored = await Movie.find({})
    expect(stored).to.have.length(movieSeeds.length)
    expect(movieSeeds.length).to.be.at.least(25)
    const genres = new Set(movieSeeds.flatMap((movie) => movie.genres))
    expect(genres.size).to.be.at.least(6)
    const ratings = movieSeeds.map((movie) => movie.averageRating)
    expect(Math.min(...ratings)).to.be.at.most(5)
    expect(Math.max(...ratings)).to.be.at.least(8)
    expect(stored.every((movie) => movie.cast.length > 0)).to.equal(true)
  })
})

describe('seedUsers', () => {
  useTestDb()

  it('creates three users with hashed passwords', async () => {
    await seedUsers()

    const stored = await User.find({})

    expect(stored).to.have.length(3)
    expect(seedUsersData).to.have.length(3)
    expect(stored.some((user) => user.role === 'admin')).to.equal(true)
    stored.forEach((user) => expect(user.passwordHash).to.have.length.greaterThan(20))
  })
})
