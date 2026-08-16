import { expect } from 'chai'
import { useTestDb, httpAgent } from './helpers.js'

describe('http surface', () => {
  useTestDb()

  it('creates an account, writes a document to the primary, and reads it back strongly', async () => {
    const created = await httpAgent.post('/api/accounts').send({ name: 'alice' })
    const write = await httpAgent.post('/api/documents').send({ accountId: created.body.id, docKey: 'profile', body: 'hello' })

    const strong = await httpAgent.get(`/api/documents/${created.body.id}/profile`).query({ consistency: 'strong' })

    expect(created.status).to.equal(201)
    expect(write.status).to.equal(201)
    expect(write.body.source).to.equal('primary')
    expect(write.body.version).to.be.a('number')
    expect(strong.status).to.equal(200)
    expect(strong.body.source).to.equal('primary')
    expect(strong.body.body).to.equal('hello')
  })

  it('routes a plain read to a replica and exposes replica positions via the state endpoint', async () => {
    const created = await httpAgent.post('/api/accounts').send({ name: 'bob' })
    await httpAgent.post('/api/documents').send({ accountId: created.body.id, docKey: 'profile', body: 'hello' })

    const plain = await httpAgent.get(`/api/documents/${created.body.id}/profile`)
    const ticked = await httpAgent.post('/api/replication/tick')
    const state = await httpAgent.get('/api/replication/state')

    expect(plain.body.source).to.equal('replica')
    expect(ticked.body.ticked).to.have.length.of.at.least(1)
    expect(state.body.primaryPosition).to.be.at.least(1)
    expect(state.body.replicas).to.be.an('array')
  })

  it('rejects a write to an account that does not exist', async () => {
    const write = await httpAgent.post('/api/documents').send({ accountId: 999999, docKey: 'k', body: 'x' })

    expect(write.status).to.equal(400)
    expect(write.body.error).to.equal('accountId does not exist')
  })
})
