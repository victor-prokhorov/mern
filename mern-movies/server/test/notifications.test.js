import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import mongoose from 'mongoose'
import app from '../src/app.js'
import Actor from '../src/models/actor.js'
import Follow from '../src/models/follow.js'
import Notification from '../src/models/notification.js'
import User from '../src/models/user.js'
import { fanoutNewMovie } from '../src/notifications/fanout.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

async function createUser(role = 'user') {
  return User.create({ name: 'Test User', email: `${role}-${Date.now()}-${Math.random()}@movies.test`, passwordHash: 'x', role })
}

async function createMovie(admin, actorIds) {
  const res = await request
    .execute(app)
    .post('/api/movies')
    .set('x-user-id', admin._id.toString())
    .send({ title: 'New Release', genres: ['action'], cast: actorIds, averageRating: 8, releasedAt: '2024-01-01' })
  return res
}

describe('POST /api/actors/:id/follow', () => {
  useTestDb()

  it('lets a user follow an actor', async () => {
    const user = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })

    const res = await request.execute(app).post(`/api/actors/${actor._id}/follow`).set('x-user-id', user._id.toString())

    expect(res).to.have.status(201)
    const stored = await Follow.find({ user: user._id, actor: actor._id })
    expect(stored).to.have.length(1)
  })

  it('is idempotent when following twice', async () => {
    const user = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })
    await request.execute(app).post(`/api/actors/${actor._id}/follow`).set('x-user-id', user._id.toString())

    await request.execute(app).post(`/api/actors/${actor._id}/follow`).set('x-user-id', user._id.toString())

    const stored = await Follow.find({ user: user._id, actor: actor._id })
    expect(stored).to.have.length(1)
  })
})

describe('DELETE /api/actors/:id/follow', () => {
  useTestDb()

  it('lets a user unfollow an actor', async () => {
    const user = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })
    await Follow.create({ user: user._id, actor: actor._id })

    const res = await request.execute(app).delete(`/api/actors/${actor._id}/follow`).set('x-user-id', user._id.toString())

    expect(res).to.have.status(200)
    const stored = await Follow.find({ user: user._id, actor: actor._id })
    expect(stored).to.have.length(0)
  })
})

describe('movie creation fan-out', () => {
  useTestDb()

  it('notifies a follower of a cast member when the movie is created', async () => {
    const admin = await createUser('admin')
    const follower = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })
    await Follow.create({ user: follower._id, actor: actor._id })

    const res = await createMovie(admin, [actor._id.toString()])

    expect(res).to.have.status(201)
    const stored = await Notification.find({ user: follower._id })
    expect(stored).to.have.length(1)
    expect(stored[0].actor.toString()).to.equal(actor._id.toString())
    expect(stored[0].movie.toString()).to.equal(res.body._id)
    expect(stored[0].type).to.equal('actor_in_new_movie')
  })

  it('does not notify a user who does not follow any cast member', async () => {
    const admin = await createUser('admin')
    const nonFollower = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })

    await createMovie(admin, [actor._id.toString()])

    const stored = await Notification.find({ user: nonFollower._id })
    expect(stored).to.have.length(0)
  })

  it('notifies once per followed actor when a user follows two cast members of the same movie', async () => {
    const admin = await createUser('admin')
    const follower = await createUser()
    const actorOne = await Actor.create({ name: 'Keanu Reeves' })
    const actorTwo = await Actor.create({ name: 'Scarlett Johansson' })
    await Follow.create({ user: follower._id, actor: actorOne._id })
    await Follow.create({ user: follower._id, actor: actorTwo._id })

    await createMovie(admin, [actorOne._id.toString(), actorTwo._id.toString()])

    const stored = await Notification.find({ user: follower._id })
    expect(stored).to.have.length(2)
    expect(stored.map((n) => n.actor.toString()).sort()).to.deep.equal([actorOne._id.toString(), actorTwo._id.toString()].sort())
  })

  it('writes nothing when the cast has no followers', async () => {
    const admin = await createUser('admin')
    const actor = await Actor.create({ name: 'Keanu Reeves' })

    await createMovie(admin, [actor._id.toString()])

    const stored = await Notification.find({})
    expect(stored).to.have.length(0)
  })

  it('re-running the fan-out for the same movie creates nothing new', async () => {
    const follower = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })
    await Follow.create({ user: follower._id, actor: actor._id })
    const movie = { _id: new mongoose.Types.ObjectId(), cast: [actor._id] }

    await fanoutNewMovie(movie)
    await fanoutNewMovie(movie)

    const stored = await Notification.find({ user: follower._id })
    expect(stored).to.have.length(1)
  })

  it('still returns 201 for the movie when the notification write fails entirely', async () => {
    const admin = await createUser('admin')
    const follower = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })
    await Follow.create({ user: follower._id, actor: actor._id })
    await mongoose.connection.db.command({
      collMod: 'notifications',
      validator: { $jsonSchema: { required: ['neverPresentField'] } },
      validationLevel: 'strict'
    })

    const res = await createMovie(admin, [actor._id.toString()])

    expect(res).to.have.status(201)
    const stored = await Notification.find({})
    expect(stored).to.have.length(0)
  })

  it('does not notify a follower who unfollowed before the movie was added', async () => {
    const admin = await createUser('admin')
    const follower = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })
    await request.execute(app).post(`/api/actors/${actor._id}/follow`).set('x-user-id', follower._id.toString())
    await request.execute(app).delete(`/api/actors/${actor._id}/follow`).set('x-user-id', follower._id.toString())

    await createMovie(admin, [actor._id.toString()])

    const stored = await Notification.find({ user: follower._id })
    expect(stored).to.have.length(0)
  })

  it('leaves existing notifications alone when a follower unfollows afterwards', async () => {
    const admin = await createUser('admin')
    const follower = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })
    await Follow.create({ user: follower._id, actor: actor._id })
    await createMovie(admin, [actor._id.toString()])

    await request.execute(app).delete(`/api/actors/${actor._id}/follow`).set('x-user-id', follower._id.toString())

    const stored = await Notification.find({ user: follower._id })
    expect(stored).to.have.length(1)
  })
})

describe('GET /api/notifications', () => {
  useTestDb()

  it('returns unread notifications before read ones', async () => {
    const user = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })
    const movieOne = new mongoose.Types.ObjectId()
    const movieTwo = new mongoose.Types.ObjectId()
    const unread = await Notification.create({ user: user._id, type: 'actor_in_new_movie', actor: actor._id, movie: movieOne })
    const read = await Notification.create({ user: user._id, type: 'actor_in_new_movie', actor: actor._id, movie: movieTwo, readAt: new Date() })

    const res = await request.execute(app).get('/api/notifications').set('x-user-id', user._id.toString())

    expect(res).to.have.status(200)
    expect(res.body).to.have.length(2)
    expect(res.body[0]._id).to.equal(unread._id.toString())
    expect(res.body[1]._id).to.equal(read._id.toString())
  })

  it('rejects a request with no x-user-id header', async () => {
    const res = await request.execute(app).get('/api/notifications')

    expect(res).to.have.status(401)
  })
})

describe('POST /api/notifications/:id/read', () => {
  useTestDb()

  it('marks a notification read', async () => {
    const user = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })
    const notification = await Notification.create({ user: user._id, type: 'actor_in_new_movie', actor: actor._id, movie: new mongoose.Types.ObjectId() })

    const res = await request.execute(app).post(`/api/notifications/${notification._id}/read`).set('x-user-id', user._id.toString())

    expect(res).to.have.status(200)
    expect(res.body.readAt).to.not.equal(null)
    const stored = await Notification.findById(notification._id)
    expect(stored.readAt).to.not.equal(null)
  })

  it('rejects marking another user\'s notification as read', async () => {
    const owner = await createUser()
    const intruder = await createUser()
    const actor = await Actor.create({ name: 'Keanu Reeves' })
    const notification = await Notification.create({ user: owner._id, type: 'actor_in_new_movie', actor: actor._id, movie: new mongoose.Types.ObjectId() })

    const res = await request.execute(app).post(`/api/notifications/${notification._id}/read`).set('x-user-id', intruder._id.toString())

    expect(res).to.have.status(404)
    const stored = await Notification.findById(notification._id)
    expect(stored.readAt).to.equal(null)
  })

  it('rejects a request with no x-user-id header', async () => {
    const actor = await Actor.create({ name: 'Keanu Reeves' })
    const notification = await Notification.create({ user: new mongoose.Types.ObjectId(), type: 'actor_in_new_movie', actor: actor._id, movie: new mongoose.Types.ObjectId() })

    const res = await request.execute(app).post(`/api/notifications/${notification._id}/read`)

    expect(res).to.have.status(401)
    const stored = await Notification.findById(notification._id)
    expect(stored.readAt).to.equal(null)
  })
})
