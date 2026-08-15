import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Ticket from '../src/models/ticket.js'
import TicketEvent from '../src/models/ticketEvent.js'
import { seedUsers } from '../src/seed.js'
import { casWriteOrConflict } from '../src/services/tickets.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

async function captureRejection(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err
  }
}

async function createTicket(userId, overrides = {}) {
  return request
    .execute(app)
    .post('/api/tickets')
    .set('x-user-id', userId)
    .send({ title: 'Cannot log in', body: 'Password reset link is broken.', priority: 'normal', ...overrides })
}

describe('optimistic concurrency', () => {
  useTestDb()

  it('rejects a mutating PATCH with no If-Match header', async () => {
    const [, gale, , rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())

    const res = await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', gale._id.toString()).send({ status: 'triaged' })

    expect(res).to.have.status(428)
    expect(res.body.error).to.equal('If-Match header is required')
  })

  it('rejects a malformed If-Match header', async () => {
    const [, gale, , rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())

    const res = await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', gale._id.toString()).set('If-Match', 'nonsense').send({ status: 'triaged' })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('malformed If-Match header')
  })

  it('round-trips the ETag from GET into a successful If-Match on PATCH', async () => {
    const [, gale, , rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())
    const fetched = await request.execute(app).get(`/api/tickets/${created.body._id}`).set('x-user-id', rae._id.toString())

    const res = await request
      .execute(app)
      .patch(`/api/tickets/${created.body._id}/status`)
      .set('x-user-id', gale._id.toString())
      .set('If-Match', fetched.headers.etag)
      .send({ status: 'triaged' })

    expect(fetched.headers.etag).to.equal('"1"')
    expect(res).to.have.status(200)
    expect(res.body.status).to.equal('triaged')
    expect(res.headers.etag).to.equal('"2"')
  })

  it('lets exactly one of two concurrent assignee updates on the same version win, and the ticket ends in the winner\'s state', async () => {
    const [ada, gale, remy, rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())

    const [toGale, toRemy] = await Promise.all([
      request.execute(app).patch(`/api/tickets/${created.body._id}/assignee`).set('x-user-id', gale._id.toString()).set('If-Match', '"1"').send({ assigneeId: gale._id.toString() }),
      request.execute(app).patch(`/api/tickets/${created.body._id}/assignee`).set('x-user-id', ada._id.toString()).set('If-Match', '"1"').send({ assigneeId: remy._id.toString() })
    ])

    const statuses = [toGale.status, toRemy.status].sort()
    expect(statuses).to.deep.equal([200, 412])
    const winner = toGale.status === 200 ? toGale : toRemy
    const loser = toGale.status === 200 ? toRemy : toGale
    const finalTicket = await request.execute(app).get(`/api/tickets/${created.body._id}`).set('x-user-id', rae._id.toString())
    expect(finalTicket.body.ticket.assignee).to.equal(winner.body.assignee)
    expect(loser.body.version).to.equal(2)
    expect(loser.body.ticket.assignee).to.equal(winner.body.assignee)
  })

  it('rejects a stale If-Match after a successful write with the current version and state in the body', async () => {
    const [, gale, , rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())
    await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', gale._id.toString()).set('If-Match', '"1"').send({ status: 'triaged' })

    const res = await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', gale._id.toString()).set('If-Match', '"1"').send({ status: 'in_progress' })

    expect(res).to.have.status(412)
    expect(res.body.version).to.equal(2)
    expect(res.body.ticket.status).to.equal('triaged')
  })

  it('increments the version exactly once per successful write, never on a rejected one', async () => {
    const [, gale, , rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())
    await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', gale._id.toString()).set('If-Match', '"1"').send({ status: 'triaged' })

    const rejected = await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', gale._id.toString()).set('If-Match', '"1"').send({ status: 'in_progress' })
    const after = await request.execute(app).get(`/api/tickets/${created.body._id}`).set('x-user-id', rae._id.toString())

    expect(rejected).to.have.status(412)
    expect(after.headers.etag).to.equal('"2"')
  })

  it('records the resulting version on the audit event for a successful status change', async () => {
    const [, gale, , rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())

    await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', gale._id.toString()).set('If-Match', '"1"').send({ status: 'triaged' })

    const events = await TicketEvent.find({ ticket: created.body._id, type: 'status_changed' })
    expect(events).to.have.length(1)
    expect(events[0].version).to.equal(2)
  })

  it('redacts moderation terms from the 412 conflict body for a subject who cannot see them', async () => {
    const [, , , rae] = await seedUsers()
    const created = await createTicket(rae._id.toString())
    const ticket = await Ticket.findById(created.body._id)

    const err = await captureRejection(casWriteOrConflict(ticket, { status: 'ok', version: 999 }, { status: 'triaged' }, { role: 'reporter' }))

    expect(err.ticket.moderation).to.deep.equal({ flagged: false })
  })
})
