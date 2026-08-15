import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Ticket from '../src/models/ticket.js'
import TicketEvent from '../src/models/ticketEvent.js'
import { seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

async function createTicket(userId, overrides = {}) {
  return request
    .execute(app)
    .post('/api/tickets')
    .set('x-user-id', userId)
    .send({ title: 'Cannot log in', body: 'Password reset link is broken.', priority: 'normal', ...overrides })
}

describe('tickets', () => {
  useTestDb()

  it('rejects requests without an x-user-id header', async () => {
    const res = await request.execute(app).get('/api/tickets')

    expect(res).to.have.status(401)
    expect(res.body.error).to.equal('x-user-id header is required')
  })

  it('creates a ticket as open and writes a created event', async () => {
    const [, , , rae] = await seedUsers()

    const res = await createTicket(rae._id.toString())

    expect(res).to.have.status(201)
    expect(res.body.status).to.equal('open')
    expect(res.body.reporter).to.equal(rae._id.toString())
    expect(res.body.teamId).to.equal(rae.teamId)
    const events = await TicketEvent.find({ ticket: res.body._id })
    expect(events).to.have.length(1)
    expect(events[0].type).to.equal('created')
    expect(events[0].to).to.equal('open')
  })

  const dueAtCases = [
    { priority: 'urgent', hours: 4 },
    { priority: 'high', hours: 24 },
    { priority: 'normal', hours: 72 },
    { priority: 'low', hours: 168 }
  ]

  for (const { priority, hours } of dueAtCases) {
    it(`sets dueAt to ${hours}h out for ${priority} priority`, async () => {
      const [, , , rae] = await seedUsers()

      const before = Date.now()
      const res = await createTicket(rae._id.toString(), { priority })

      const dueAt = new Date(res.body.dueAt).getTime()
      const expected = before + hours * 60 * 60 * 1000
      expect(Math.abs(dueAt - expected)).to.be.lessThan(5000)
    })
  }

  it('rejects an invalid priority', async () => {
    const [, , , rae] = await seedUsers()

    const res = await createTicket(rae._id.toString(), { priority: 'medium' })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('invalid priority')
  })

  it('filters tickets by status, assignee and priority', async () => {
    const [, gale, , rae] = await seedUsers()
    const first = await createTicket(rae._id.toString(), { priority: 'high' })
    await createTicket(rae._id.toString(), { priority: 'low', body: 'Export is very slow today.' })
    await request.execute(app).patch(`/api/tickets/${first.body._id}/assignee`).set('x-user-id', gale._id.toString()).send({ assigneeId: gale._id.toString() })

    const byPriority = await request.execute(app).get('/api/tickets').set('x-user-id', rae._id.toString()).query({ priority: 'high' })
    const byAssignee = await request.execute(app).get('/api/tickets').set('x-user-id', rae._id.toString()).query({ assignee: gale._id.toString() })
    const byStatus = await request.execute(app).get('/api/tickets').set('x-user-id', rae._id.toString()).query({ status: 'open' })

    expect(byPriority.body).to.have.length(1)
    expect(byAssignee.body).to.have.length(1)
    expect(byStatus.body).to.have.length(2)
  })

  it('returns a ticket with its comments and events', async () => {
    const [, , , rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())
    await request.execute(app).post(`/api/tickets/${created.body._id}/comments`).set('x-user-id', rae._id.toString()).send({ body: 'any update?' })

    const res = await request.execute(app).get(`/api/tickets/${created.body._id}`).set('x-user-id', rae._id.toString())

    expect(res).to.have.status(200)
    expect(res.body.ticket._id).to.equal(created.body._id)
    expect(res.body.comments).to.have.length(1)
    expect(res.body.comments[0].body).to.equal('any update?')
    expect(res.body.events).to.have.length(2)
  })

  it('returns 404 for an unknown ticket id', async () => {
    const [, , , rae] = await seedUsers()

    const res = await request.execute(app).get('/api/tickets/64b7f0f0f0f0f0f0f0f0f0f0').set('x-user-id', rae._id.toString())

    expect(res).to.have.status(404)
    expect(res.body.error).to.equal('ticket not found')
  })

  const legalTransitions = [
    ['open', 'triaged'],
    ['triaged', 'in_progress'],
    ['in_progress', 'resolved'],
    ['resolved', 'closed'],
    ['resolved', 'open']
  ]

  for (const [from, to] of legalTransitions) {
    it(`allows the legal transition ${from} -> ${to}`, async () => {
      const [, gale, , rae] = await seedUsers()
      const created = await createTicket(rae._id.toString())
      await Ticket.updateOne({ _id: created.body._id }, { status: from })

      const res = await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', gale._id.toString()).send({ status: to })

      expect(res).to.have.status(200)
      expect(res.body.status).to.equal(to)
      const events = await TicketEvent.find({ ticket: created.body._id, type: 'status_changed' })
      expect(events).to.have.length(1)
      expect(events[0].from).to.equal(from)
      expect(events[0].to).to.equal(to)
    })
  }

  const illegalTransitions = [
    ['open', 'resolved'],
    ['open', 'closed'],
    ['triaged', 'open']
  ]

  for (const [from, to] of illegalTransitions) {
    it(`rejects the illegal transition ${from} -> ${to}`, async () => {
      const [, gale, , rae] = await seedUsers()
      const created = await createTicket(rae._id.toString())
      await Ticket.updateOne({ _id: created.body._id }, { status: from })

      const res = await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', gale._id.toString()).send({ status: to })

      expect(res).to.have.status(400)
      expect(res.body.error).to.equal('invalid status transition')
    })
  }

  it('rejects the illegal transition closed -> open even for an admin', async () => {
    const [ada, , , rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())
    await Ticket.updateOne({ _id: created.body._id }, { status: 'closed' })

    const res = await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', ada._id.toString()).send({ status: 'open' })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('invalid status transition')
  })

  it('assigns a ticket and writes an assignee_changed event', async () => {
    const [, gale, , rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())

    const res = await request.execute(app).patch(`/api/tickets/${created.body._id}/assignee`).set('x-user-id', gale._id.toString()).send({ assigneeId: gale._id.toString() })

    expect(res).to.have.status(200)
    expect(res.body.assignee).to.equal(gale._id.toString())
    const events = await TicketEvent.find({ ticket: created.body._id, type: 'assignee_changed' })
    expect(events).to.have.length(1)
    expect(events[0].from).to.equal(null)
    expect(events[0].to).to.equal(gale._id.toString())
  })

  it('attaches a comment and writes a commented event', async () => {
    const [, , , rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())

    const res = await request.execute(app).post(`/api/tickets/${created.body._id}/comments`).set('x-user-id', rae._id.toString()).send({ body: 'looking into it' })

    expect(res).to.have.status(201)
    expect(res.body.body).to.equal('looking into it')
    const events = await TicketEvent.find({ ticket: created.body._id, type: 'commented' })
    expect(events).to.have.length(1)
  })
})
