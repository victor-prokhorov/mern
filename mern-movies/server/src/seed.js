import 'dotenv/config'
import mongoose from 'mongoose'
import bcrypt from 'bcrypt'
import { connect } from './db.js'
import * as actorsRepo from './repositories/actors.js'
import * as moviesRepo from './repositories/movies.js'
import * as usersRepo from './repositories/users.js'

export const actorNames = [
  'Keanu Reeves', 'Scarlett Johansson', 'Tom Hanks', 'Meryl Streep', 'Denzel Washington',
  'Emma Stone', 'Idris Elba', 'Natalie Portman', 'Chris Evans', 'Viola Davis',
  'Ryan Gosling', 'Zendaya'
]

export const movieSeeds = [
  { title: 'Neon Horizon', genres: ['scifi', 'action'], cast: ['Keanu Reeves', 'Scarlett Johansson'], averageRating: 8.4, releasedAt: '2023-03-01' },
  { title: 'Quiet Harbor', genres: ['drama'], cast: ['Meryl Streep', 'Tom Hanks'], averageRating: 7.9, releasedAt: '2022-06-15' },
  { title: 'Last Laugh', genres: ['comedy'], cast: ['Emma Stone', 'Ryan Gosling'], averageRating: 6.5, releasedAt: '2021-11-20' },
  { title: 'Cold Case Nine', genres: ['thriller', 'drama'], cast: ['Denzel Washington', 'Viola Davis'], averageRating: 8.1, releasedAt: '2020-09-05' },
  { title: 'The Long Dark', genres: ['horror'], cast: ['Idris Elba', 'Natalie Portman'], averageRating: 5.8, releasedAt: '2019-10-30' },
  { title: 'City of Echoes', genres: ['documentary'], cast: ['Chris Evans'], averageRating: 7.2, releasedAt: '2023-01-10' },
  { title: 'Signal Lost', genres: ['scifi', 'thriller'], cast: ['Keanu Reeves', 'Idris Elba'], averageRating: 8.8, releasedAt: '2024-02-14' },
  { title: 'Summer of Us', genres: ['romance', 'comedy'], cast: ['Zendaya', 'Ryan Gosling'], averageRating: 6.9, releasedAt: '2022-07-04' },
  { title: 'Iron Verdict', genres: ['action', 'thriller'], cast: ['Denzel Washington', 'Chris Evans'], averageRating: 7.6, releasedAt: '2021-05-21' },
  { title: 'Paper Moonlight', genres: ['drama', 'romance'], cast: ['Meryl Streep', 'Natalie Portman'], averageRating: 8.3, releasedAt: '2020-12-01' },
  { title: 'Static Bloom', genres: ['scifi'], cast: ['Scarlett Johansson', 'Zendaya'], averageRating: 6.1, releasedAt: '2023-08-19' },
  { title: 'Funny Business', genres: ['comedy'], cast: ['Tom Hanks', 'Emma Stone'], averageRating: 7.4, releasedAt: '2019-04-12' },
  { title: 'The Devil Waits', genres: ['horror', 'thriller'], cast: ['Viola Davis', 'Idris Elba'], averageRating: 7.0, releasedAt: '2018-10-13' },
  { title: 'Northbound', genres: ['drama'], cast: ['Denzel Washington', 'Tom Hanks'], averageRating: 8.6, releasedAt: '2022-03-18' },
  { title: 'Second Sun', genres: ['scifi', 'drama'], cast: ['Natalie Portman', 'Chris Evans'], averageRating: 8.0, releasedAt: '2021-09-09' },
  { title: 'Karaoke Nights', genres: ['comedy', 'romance'], cast: ['Ryan Gosling', 'Zendaya'], averageRating: 5.5, releasedAt: '2020-06-06' },
  { title: 'Vanishing Point City', genres: ['thriller'], cast: ['Keanu Reeves', 'Viola Davis'], averageRating: 7.8, releasedAt: '2019-11-01' },
  { title: 'The Quiet War', genres: ['documentary', 'drama'], cast: ['Meryl Streep'], averageRating: 6.7, releasedAt: '2023-05-25' },
  { title: 'Reckless Bloom', genres: ['action', 'romance'], cast: ['Scarlett Johansson', 'Chris Evans'], averageRating: 7.3, releasedAt: '2022-01-07' },
  { title: 'Nightshade', genres: ['horror'], cast: ['Idris Elba', 'Emma Stone'], averageRating: 4.9, releasedAt: '2021-10-31' },
  { title: 'The Understudy', genres: ['drama', 'comedy'], cast: ['Tom Hanks', 'Zendaya'], averageRating: 7.1, releasedAt: '2020-02-14' },
  { title: 'Orbit Falling', genres: ['scifi', 'action'], cast: ['Keanu Reeves', 'Natalie Portman'], averageRating: 9.0, releasedAt: '2024-06-21' },
  { title: 'Small Mercies', genres: ['drama'], cast: ['Viola Davis', 'Denzel Washington'], averageRating: 8.2, releasedAt: '2019-03-15' },
  { title: 'Loud Silence', genres: ['thriller', 'horror'], cast: ['Ryan Gosling', 'Emma Stone'], averageRating: 6.3, releasedAt: '2018-08-08' },
  { title: 'The Long Goodbye Tour', genres: ['documentary'], cast: ['Scarlett Johansson', 'Meryl Streep'], averageRating: 7.5, releasedAt: '2023-12-01' }
]

export const seedUsersData = [
  { name: 'Ada Admin', email: 'admin@movies.test', password: 'admin1234', role: 'admin' },
  { name: 'Fiona Fan', email: 'fiona@movies.test', password: 'fiona1234', role: 'user' },
  { name: 'Sam Viewer', email: 'sam@movies.test', password: 'sam12345', role: 'user' }
]

export async function seedActors() {
  await actorsRepo.deleteAll()
  return actorsRepo.insertMany(actorNames.map((name) => ({ name })))
}

export async function seedMovies(actors) {
  await moviesRepo.deleteAll()
  const idByName = new Map(actors.map((actor) => [actor.name, actor._id]))
  const docs = movieSeeds.map((seed) => ({
    title: seed.title,
    genres: seed.genres,
    cast: seed.cast.map((name) => idByName.get(name)),
    averageRating: seed.averageRating,
    releasedAt: new Date(seed.releasedAt)
  }))
  return moviesRepo.insertMany(docs)
}

export async function seedUsers() {
  await usersRepo.deleteAll()
  const docs = await Promise.all(seedUsersData.map(async (seed) => ({
    name: seed.name,
    email: seed.email,
    passwordHash: await bcrypt.hash(seed.password, 10),
    role: seed.role
  })))
  return usersRepo.insertMany(docs)
}

if (process.env.NODE_ENV !== 'test') {
  await connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-movies')
  const actors = await seedActors()
  const movies = await seedMovies(actors)
  const users = await seedUsers()
  console.log(`seeded ${actors.length} actors, ${movies.length} movies, ${users.length} users`)
  users.forEach((user) => console.log(`  ${user.role}: ${user.email} -> ${user._id}`))
  await mongoose.disconnect()
}
