import { expect, use } from 'chai'
import chaiHttp from 'chai-http'
import { pool } from '../src/db.js'
import * as accountsRepo from '../src/repositories/accounts.js'
import { useTestDb, createAccount, makeTransfer, httpAgent } from './helpers.js'

use(chaiHttp)

describe('ledger', () => {
  useTestDb()

  it('writes exactly two entries summing to zero for a transfer', async () => {
    const from = await createAccount({ name: 'alice' })
    const to = await createAccount({ name: 'bob' })

    const res = await httpAgent.post('/api/transfers').send({ reference: 'tx-1', fromAccountId: from.id, toAccountId: to.id, amountMinor: 500 })

    expect(res).to.have.status(201)
    const { rows } = await pool.query('SELECT amount_minor FROM entries WHERE transfer_id = $1 ORDER BY id', [res.body.id])
    expect(rows).to.have.length(2)
    const sum = rows.reduce((acc, row) => acc + Number(row.amount_minor), 0)
    expect(sum).to.equal(0)
  })

  it('rejects a transfer to a non-existent account and leaves nothing behind', async () => {
    const from = await createAccount({ name: 'alice' })

    const res = await httpAgent.post('/api/transfers').send({ reference: 'tx-2', fromAccountId: from.id, toAccountId: from.id + 999999, amountMinor: 100 })

    expect(res).to.have.status(400)
    const transfers = await pool.query('SELECT * FROM transfers WHERE reference = $1', ['tx-2'])
    const entries = await pool.query('SELECT * FROM entries')
    expect(transfers.rows).to.have.length(0)
    expect(entries.rows).to.have.length(0)
  })

  it('rejects a duplicate reference', async () => {
    const from = await createAccount({ name: 'alice' })
    const to = await createAccount({ name: 'bob' })
    await httpAgent.post('/api/transfers').send({ reference: 'tx-dup', fromAccountId: from.id, toAccountId: to.id, amountMinor: 100 })

    const res = await httpAgent.post('/api/transfers').send({ reference: 'tx-dup', fromAccountId: from.id, toAccountId: to.id, amountMinor: 100 })

    expect(res).to.have.status(409)
  })

  it('computes balance as the sum of entries', async () => {
    const from = await createAccount({ name: 'alice' })
    const to = await createAccount({ name: 'bob' })
    await httpAgent.post('/api/transfers').send({ reference: 'tx-3', fromAccountId: from.id, toAccountId: to.id, amountMinor: 700 })

    const res = await httpAgent.get(`/api/accounts/${to.id}/balance`)

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

  it('rejects a commit that reassigns an entry to another transfer and leaves the old transfer unbalanced', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    const transferA = await makeTransfer(alice.id, bob.id, 500, 'reassign-a')
    const transferB = await makeTransfer(alice.id, bob.id, 500, 'reassign-b')
    const client = await pool.connect()

    await client.query('BEGIN')
    await client.query('UPDATE entries SET transfer_id = $1 WHERE transfer_id = $2 AND amount_minor = 500', [transferB.id, transferA.id])
    await client.query('INSERT INTO entries (transfer_id, account_id, amount_minor) VALUES ($1, $2, -500)', [transferB.id, bob.id])
    let commitError = null
    try {
      await client.query('COMMIT')
    } catch (err) {
      commitError = err
    }
    client.release()

    expect(commitError).to.not.equal(null)
    expect(commitError.message).to.include('do not sum to zero')
  })

  it('keeps the stored balance_minor equal to the sum of entries after a series of transfers', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    const carol = await createAccount({ name: 'carol' })
    await makeTransfer(alice.id, bob.id, 500, 'bal-1')
    await makeTransfer(bob.id, carol.id, 200, 'bal-2')
    await makeTransfer(carol.id, alice.id, 150, 'bal-3')
    await makeTransfer(bob.id, alice.id, 50, 'bal-4')

    const stored = []
    const derived = []
    for (const account of [alice, bob, carol]) {
      stored.push(await accountsRepo.getStoredBalance(pool, account.id))
      derived.push(await accountsRepo.computeDerivedBalance(pool, account.id))
    }

    expect(stored).to.deep.equal([-300n, 250n, 50n])
    expect(stored).to.deep.equal(derived)
  })

  it('completes 20 concurrent opposing transfer pairs without a deadlock surfacing as 500', async function () {
    this.timeout(60000)
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })

    const requests = []
    for (let i = 0; i < 20; i += 1) {
      requests.push(httpAgent.post('/api/transfers').send({ reference: `dl-ab-${i}`, fromAccountId: alice.id, toAccountId: bob.id, amountMinor: 10 }))
      requests.push(httpAgent.post('/api/transfers').send({ reference: `dl-ba-${i}`, fromAccountId: bob.id, toAccountId: alice.id, amountMinor: 10 }))
    }
    const responses = await Promise.all(requests)

    const statuses = responses.map((res) => res.status)
    expect(statuses).to.deep.equal(statuses.map(() => 201))
  })

  it('rejects an amountMinor beyond the safely representable integer range', async () => {
    const from = await createAccount({ name: 'alice' })
    const to = await createAccount({ name: 'bob' })

    const res = await httpAgent.post('/api/transfers').send({ reference: 'unsafe-1', fromAccountId: from.id, toAccountId: to.id, amountMinor: 9007199254740993 })

    expect(res).to.have.status(400)
  })

  it('stores a hostile reference value as data rather than executing it', async () => {
    const from = await createAccount({ name: 'alice' })
    const to = await createAccount({ name: 'bob' })
    const hostile = "x'); DROP TABLE transfers; --"

    const res = await httpAgent.post('/api/transfers').send({ reference: hostile, fromAccountId: from.id, toAccountId: to.id, amountMinor: 50 })

    expect(res).to.have.status(201)
    expect(res.body.reference).to.equal(hostile)
    const stillExists = await pool.query("SELECT to_regclass('public.transfers') AS name")
    expect(stillExists.rows[0].name).to.equal('transfers')
  })
})
