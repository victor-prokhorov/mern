import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import { pool } from '../src/db.js'
import { useTestDb, createAccount } from './helpers.js'

use(chaiHttp)

describe('ledger', () => {
  useTestDb()

  it('writes exactly two entries summing to zero for a transfer', async () => {
    const from = await createAccount({ name: 'alice' })
    const to = await createAccount({ name: 'bob' })

    const res = await request.execute(app).post('/api/transfers').send({ reference: 'tx-1', fromAccountId: from.id, toAccountId: to.id, amountMinor: 500 })

    expect(res).to.have.status(201)
    const { rows } = await pool.query('SELECT amount_minor FROM entries WHERE transfer_id = $1 ORDER BY id', [res.body.id])
    expect(rows).to.have.length(2)
    const sum = rows.reduce((acc, row) => acc + Number(row.amount_minor), 0)
    expect(sum).to.equal(0)
  })

  it('rejects a transfer to a non-existent account and leaves nothing behind', async () => {
    const from = await createAccount({ name: 'alice' })

    const res = await request.execute(app).post('/api/transfers').send({ reference: 'tx-2', fromAccountId: from.id, toAccountId: from.id + 999999, amountMinor: 100 })

    expect(res).to.have.status(400)
    const transfers = await pool.query('SELECT * FROM transfers WHERE reference = $1', ['tx-2'])
    const entries = await pool.query('SELECT * FROM entries')
    expect(transfers.rows).to.have.length(0)
    expect(entries.rows).to.have.length(0)
  })

  it('rejects a duplicate reference', async () => {
    const from = await createAccount({ name: 'alice' })
    const to = await createAccount({ name: 'bob' })
    await request.execute(app).post('/api/transfers').send({ reference: 'tx-dup', fromAccountId: from.id, toAccountId: to.id, amountMinor: 100 })

    const res = await request.execute(app).post('/api/transfers').send({ reference: 'tx-dup', fromAccountId: from.id, toAccountId: to.id, amountMinor: 100 })

    expect(res).to.have.status(409)
  })

  it('computes balance as the sum of entries', async () => {
    const from = await createAccount({ name: 'alice' })
    const to = await createAccount({ name: 'bob' })
    await request.execute(app).post('/api/transfers').send({ reference: 'tx-3', fromAccountId: from.id, toAccountId: to.id, amountMinor: 700 })

    const res = await request.execute(app).get(`/api/accounts/${to.id}/balance`)

    expect(res).to.have.status(200)
    expect(res.body.balanceMinor).to.equal('700')
  })

  it('enforces at the database level that a transfer\'s entries sum to zero, rejecting direct SQL tampering', async () => {
    const alice = await createAccount({ name: 'alice' })
    const { rows } = await pool.query("INSERT INTO transfers (reference, status) VALUES ($1, 'completed') RETURNING id", ['direct-tamper-1'])
    const transferId = rows[0].id

    let caught
    try {
      await pool.query('INSERT INTO entries (transfer_id, account_id, amount_minor) VALUES ($1, $2, $3)', [transferId, alice.id, 500])
    } catch (err) {
      caught = err
    }

    expect(caught).to.not.equal(undefined)
    expect(caught.message).to.include('do not sum to zero')
  })

  it('rejects an amountMinor beyond the safely representable integer range', async () => {
    const from = await createAccount({ name: 'alice' })
    const to = await createAccount({ name: 'bob' })

    const res = await request.execute(app).post('/api/transfers').send({ reference: 'unsafe-1', fromAccountId: from.id, toAccountId: to.id, amountMinor: 9007199254740993 })

    expect(res).to.have.status(400)
  })

  it('stores a hostile reference value as data rather than executing it', async () => {
    const from = await createAccount({ name: 'alice' })
    const to = await createAccount({ name: 'bob' })
    const hostile = "x'); DROP TABLE transfers; --"

    const res = await request.execute(app).post('/api/transfers').send({ reference: hostile, fromAccountId: from.id, toAccountId: to.id, amountMinor: 50 })

    expect(res).to.have.status(201)
    expect(res.body.reference).to.equal(hostile)
    const stillExists = await pool.query("SELECT to_regclass('public.transfers') AS name")
    expect(stillExists.rows[0].name).to.equal('transfers')
  })
})
