import { expect } from 'chai'
import Follow from '../src/models/follow.js'
import Movie from '../src/models/movie.js'
import Notification from '../src/models/notification.js'
import { useTestDb } from './helpers.js'

function keysOf(indexes) {
  return indexes.map((index) => index.key)
}

describe('secondary indexes', () => {
  useTestDb()

  it('indexes Follow by actor for the fan-out lookup', async () => {
    const indexes = await Follow.listIndexes()

    expect(keysOf(indexes)).to.deep.include({ actor: 1 })
  })

  it('indexes Notification by user, readAt, createdAt for the list endpoint', async () => {
    const indexes = await Notification.listIndexes()

    expect(keysOf(indexes)).to.deep.include({ user: 1, readAt: 1, createdAt: -1 })
  })

  it('indexes Movie by genres for the genre filter', async () => {
    const indexes = await Movie.listIndexes()

    expect(keysOf(indexes)).to.deep.include({ genres: 1 })
  })

  it('indexes Movie by averageRating for the eligibility floor', async () => {
    const indexes = await Movie.listIndexes()

    expect(keysOf(indexes)).to.deep.include({ averageRating: 1 })
  })
})
