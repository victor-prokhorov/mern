import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import { ObjectId } from 'mongodb'
import app from '../src/app.js'
import { decide } from '../src/policy/engine.js'
import { policies } from '../src/policy/policies.js'
import { seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

function baseRequest(overrides = {}) {
  return {
    subject: { id: new ObjectId().toString(), role: 'reporter', teamId: 'team-a' },
    action: 'ticket:read',
    resource: null,
    context: {},
    ...overrides
  }
}

describe('policy engine', () => {
  useTestDb()

  it('denies everything when the policy set is empty', () => {
    const decision = decide([], baseRequest())

    expect(decision.effect).to.equal('deny')
  })

  it('lets a deny rule override a matching permit rule', () => {
    const subjectId = new ObjectId().toString()
    const permitAll = { id: 'permit-all', effect: 'permit', actions: ['ticket:transition'], roles: ['reporter'], reason: 'test permit', condition: () => true }
    const denyAll = { id: 'deny-all', effect: 'deny', actions: ['ticket:transition'], roles: ['reporter'], reason: 'test deny', condition: () => true }

    const decision = decide([permitAll, denyAll], baseRequest({ subject: { id: subjectId, role: 'reporter', teamId: 'team-a' }, action: 'ticket:transition' }))

    expect(decision.effect).to.equal('deny')
    expect(decision.ruleId).to.equal('deny-all')
  })

  it('always carries a reason, for both permit and deny decisions', () => {
    const permitRule = { id: 'permit-1', effect: 'permit', actions: ['ticket:read'], roles: ['reporter'], reason: 'reporters may read', condition: () => true }

    const permitDecision = decide([permitRule], baseRequest({ action: 'ticket:read' }))
    const denyDecision = decide([], baseRequest())

    expect(permitDecision.reason).to.be.a('string').and.not.equal('')
    expect(denyDecision.reason).to.be.a('string').and.not.equal('')
  })

  it('denies admins from deleting tickets despite their wildcard permit', () => {
    const admin = { id: new ObjectId().toString(), role: 'admin', teamId: 'team-a' }

    const decision = decide(policies, baseRequest({ subject: admin, action: 'ticket:delete', resource: { reporter: admin.id, teamId: 'team-a', status: 'open' } }))

    expect(decision.effect).to.equal('deny')
    expect(decision.ruleId).to.equal('admin-no-delete')
  })

  it('exempts only admins from the closed-ticket deny at the policy layer, though the domain still refuses the transition', () => {
    const closedTicket = { reporter: new ObjectId().toString(), teamId: 'team-a', status: 'closed' }
    const admin = { id: new ObjectId().toString(), role: 'admin', teamId: 'team-a' }
    const agent = { id: new ObjectId().toString(), role: 'agent', teamId: 'team-a' }

    const adminDecision = decide(policies, baseRequest({ subject: admin, action: 'ticket:transition', resource: closedTicket }))
    const agentDecision = decide(policies, baseRequest({ subject: agent, action: 'ticket:transition', resource: closedTicket }))

    expect(adminDecision.effect).to.equal('permit')
    expect(agentDecision.effect).to.equal('deny')
  })

  it('lets a reporter read their own ticket over HTTP', async () => {
    const [, , , rae] = await seedUsers()
    const created = await request.execute(app).post('/api/tickets').set('x-user-id', rae._id.toString()).send({ title: 'a', body: 'b', priority: 'normal' })

    const res = await request.execute(app).get(`/api/tickets/${created.body._id}`).set('x-user-id', rae._id.toString())

    expect(res).to.have.status(200)
  })

  it('403s a reporter reading another reporter\'s ticket', async () => {
    const [, , , rae, sam] = await seedUsers()
    const created = await request.execute(app).post('/api/tickets').set('x-user-id', sam._id.toString()).send({ title: 'a', body: 'b', priority: 'normal' })

    const res = await request.execute(app).get(`/api/tickets/${created.body._id}`).set('x-user-id', rae._id.toString())

    expect(res).to.have.status(403)
    expect(res.body.error).to.equal('forbidden')
  })

  it('lets an agent transition a ticket inside their own team', async () => {
    const [, gale, , rae] = await seedUsers()
    const created = await request.execute(app).post('/api/tickets').set('x-user-id', rae._id.toString()).send({ title: 'a', body: 'b', priority: 'normal' })

    const res = await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', gale._id.toString()).set('If-Match', '"1"').send({ status: 'triaged' })

    expect(res).to.have.status(200)
  })

  it('403s an agent transitioning a ticket outside their team', async () => {
    const [, gale, , , , lee] = await seedUsers()
    const created = await request.execute(app).post('/api/tickets').set('x-user-id', lee._id.toString()).send({ title: 'a', body: 'b', priority: 'normal' })

    const res = await request.execute(app).patch(`/api/tickets/${created.body._id}/status`).set('x-user-id', gale._id.toString()).send({ status: 'triaged' })

    expect(res).to.have.status(403)
    expect(res.body.error).to.equal('forbidden')
  })
})
