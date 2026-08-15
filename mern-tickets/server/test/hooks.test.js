import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import { ObjectId } from 'mongodb'
import app from '../src/app.js'
import Ticket from '../src/models/ticket.js'
import { register, run, reset } from '../src/hooks/registry.js'
import { seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

describe('hook registry', () => {
  afterEach(() => {
    reset('test:order')
    reset('test:transform')
    reset('test:throw')
  })

  it('runs handlers in registration order', async () => {
    const order = []
    register('test:order', () => {
      order.push('first')
      return { action: 'continue' }
    })
    register('test:order', () => {
      order.push('second')
      return { action: 'continue' }
    })

    await run('test:order', {})

    expect(order).to.deep.equal(['first', 'second'])
  })

  it('short-circuits the chain on reject', async () => {
    let secondRan = false
    register('test:order', () => ({ action: 'reject', reason: 'nope' }))
    register('test:order', () => {
      secondRan = true
      return { action: 'continue' }
    })

    const outcome = await run('test:order', {})

    expect(outcome.action).to.equal('reject')
    expect(outcome.reason).to.equal('nope')
    expect(secondRan).to.equal(false)
  })

  it('passes a transformed payload on to the next handler', async () => {
    register('test:transform', (payload) => ({ action: 'transform', payload: { ...payload, value: payload.value + 1 } }))
    register('test:transform', (payload) => ({ action: 'transform', payload: { ...payload, value: payload.value + 1 } }))

    const outcome = await run('test:transform', { value: 0 })

    expect(outcome.action).to.equal('continue')
    expect(outcome.payload.value).to.equal(2)
  })

  it('skips a throwing handler without failing the run', async () => {
    let secondRan = false
    register('test:throw', () => {
      throw new Error('boom')
    })
    register('test:throw', () => {
      secondRan = true
      return { action: 'continue' }
    })

    const outcome = await run('test:throw', {})

    expect(outcome.action).to.equal('continue')
    expect(secondRan).to.equal(true)
  })
})

describe('moderation hooks wired into ticket creation', () => {
  useTestDb()

  it('flags a ticket whose body has more than 3 links', async () => {
    const [, , , rae] = await seedUsers()

    const res = await request
      .execute(app)
      .post('/api/tickets')
      .set('x-user-id', rae._id.toString())
      .send({
        title: 'links',
        body: 'see http://a.test http://b.test http://c.test http://d.test',
        priority: 'normal'
      })

    expect(res).to.have.status(201)
    expect(res.body.moderation.flagged).to.equal(true)
    expect(res.body.moderation.terms).to.include('link-limit-exceeded')
  })

  it('does not flag a ticket with 3 or fewer links', async () => {
    const [, , , rae] = await seedUsers()

    const res = await request
      .execute(app)
      .post('/api/tickets')
      .set('x-user-id', rae._id.toString())
      .send({ title: 'links', body: 'see http://a.test http://b.test http://c.test', priority: 'normal' })

    expect(res).to.have.status(201)
    expect(res.body.moderation.flagged).to.equal(false)
  })

  it('rejects a duplicate ticket body from the same user inside the 60 second window', async () => {
    const [, , , rae] = await seedUsers()
    await request.execute(app).post('/api/tickets').set('x-user-id', rae._id.toString()).send({ title: 'a', body: 'identical body', priority: 'normal' })

    const res = await request.execute(app).post('/api/tickets').set('x-user-id', rae._id.toString()).send({ title: 'b', body: 'identical body', priority: 'normal' })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('duplicate submission')
  })

  it('allows an identical body once the 60 second window has passed', async () => {
    const [, , , rae] = await seedUsers()
    const first = await request.execute(app).post('/api/tickets').set('x-user-id', rae._id.toString()).send({ title: 'a', body: 'identical body', priority: 'normal' })
    await Ticket.collection.updateOne({ _id: new ObjectId(first.body._id) }, { $set: { createdAt: new Date(Date.now() - 61 * 1000) } })

    const res = await request.execute(app).post('/api/tickets').set('x-user-id', rae._id.toString()).send({ title: 'b', body: 'identical body', priority: 'normal' })

    expect(res).to.have.status(201)
  })
})
