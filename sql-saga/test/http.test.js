import { expect } from 'chai'
import { pool } from '../src/db.js'
import { httpAgent, useTestDb, createItem } from './helpers.js'

describe('http surface', () => {
  useTestDb()

  it('placing an order against sufficient stock runs the full saga to completed and effects every downstream write', async () => {
    await createItem({ sku: 'WIDGET-1', available: 10 })

    const res = await httpAgent.post('/api/orders').send({ sku: 'WIDGET-1', qty: 2, amountMinor: 4999, address: '1 Test Lane' })

    expect(res.status).to.equal(201)
    expect(res.body.saga.status).to.equal('completed')
    expect(res.body.steps.map((s) => s.status)).to.deep.equal(['done', 'done', 'done', 'done'])
    expect(res.body.order.status).to.equal('placed')
    expect(res.body.payment.status).to.equal('charged')
    expect(res.body.shipment.status).to.equal('scheduled')
    const item = await httpAgent.get('/api/inventory/WIDGET-1')
    expect(item.body).to.deep.include({ sku: 'WIDGET-1', available: 8, reserved: 2 })
  })

  it('an order that cannot reserve stock aborts: the saga ends compensated, no payment is taken and inventory is untouched', async () => {
    await createItem({ sku: 'WIDGET-SCARCE', available: 1 })

    const res = await httpAgent.post('/api/orders').send({ sku: 'WIDGET-SCARCE', qty: 5, amountMinor: 9999, address: '2 Test Lane' })

    expect(res.status).to.equal(201)
    expect(res.body.saga.status).to.equal('compensated')
    expect(res.body.payment).to.equal(null)
    expect(res.body.order.status).to.equal('pending')
    const item = await httpAgent.get('/api/inventory/WIDGET-SCARCE')
    expect(item.body).to.deep.include({ sku: 'WIDGET-SCARCE', available: 1, reserved: 0 })
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM reservations')
    expect(rows[0].n).to.equal(0)
  })

  it('rejects an order for an unknown sku with 404', async () => {
    const res = await httpAgent.post('/api/orders').send({ sku: 'NOPE', qty: 1, amountMinor: 100, address: 'x' })

    expect(res.status).to.equal(404)
  })

  it('rejects an order missing required fields with 400', async () => {
    const res = await httpAgent.post('/api/orders').send({ sku: 'WIDGET-1' })

    expect(res.status).to.equal(400)
  })
})
