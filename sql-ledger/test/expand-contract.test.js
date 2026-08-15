import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import { pool } from '../src/db.js'
import * as accountsRepo from '../src/repositories/accounts.js'
import { backfillBatch, backfillBalances } from '../src/migrations/backfill.js'
import { verifyBalances } from '../src/migrations/verify.js'
import { migrate, status } from '../src/migrations/runner.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

async function createAccount(overrides = {}) {
  const res = await request.execute(app).post('/api/accounts').send({ name: 'acc', currency: 'USD', ...overrides })
  return res.body
}

async function makeTransfer(fromAccountId, toAccountId, amountMinor, reference) {
  return request.execute(app).post('/api/transfers').send({ reference, fromAccountId, toAccountId, amountMinor })
}

describe('expand-contract migration to a stored balance', () => {
  useTestDb()

  it('is resumable: interrupting the backfill and re-running reaches the same final result', async () => {
    await pool.query('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS balance_minor_not_null')
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    await makeTransfer(alice.id, bob.id, 300, 'bf-1')
    await makeTransfer(alice.id, bob.id, 150, 'bf-2')
    await pool.query('UPDATE accounts SET balance_minor = NULL')

    const firstBatchRowCount = await backfillBatch(pool, 1)
    const afterFirstBatch = await pool.query('SELECT balance_minor FROM accounts ORDER BY id')
    await backfillBalances(pool, { batchSize: 1 })

    expect(firstBatchRowCount).to.equal(1)
    expect(afterFirstBatch.rows.some((row) => row.balance_minor === null)).to.equal(true)
    const finalAlice = await accountsRepo.getStoredBalance(pool, alice.id)
    const finalBob = await accountsRepo.getStoredBalance(pool, bob.id)
    expect(finalAlice).to.equal(-450n)
    expect(finalBob).to.equal(450n)
  })

  it('dual-write keeps the stored and derived balances equal under concurrent transfers', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })

    await Promise.all([
      makeTransfer(alice.id, bob.id, 10, 'cc-1'),
      makeTransfer(alice.id, bob.id, 20, 'cc-2'),
      makeTransfer(alice.id, bob.id, 30, 'cc-3'),
      makeTransfer(alice.id, bob.id, 40, 'cc-4')
    ])

    const storedAlice = await accountsRepo.getStoredBalance(pool, alice.id)
    const derivedAlice = await accountsRepo.computeDerivedBalance(pool, alice.id)
    const storedBob = await accountsRepo.getStoredBalance(pool, bob.id)
    const derivedBob = await accountsRepo.computeDerivedBalance(pool, bob.id)
    expect(storedAlice).to.equal(derivedAlice)
    expect(storedBob).to.equal(derivedBob)
  })

  it('detects a deliberately corrupted stored balance', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    await makeTransfer(alice.id, bob.id, 500, 'vc-1')
    await accountsRepo.setBalanceForTest(pool, bob.id, 999999)

    const discrepancies = await verifyBalances(pool)

    const found = discrepancies.find((row) => row.accountId === bob.id)
    expect(found).to.not.equal(undefined)
    expect(found.stored).to.equal(999999n)
    expect(found.derived).to.equal(500n)
  })

  it('applies the full migration sequence cleanly against a fresh database, and running it twice is a no-op', async () => {
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')

    const firstRun = await migrate(pool)
    const secondRun = await migrate(pool)

    expect(firstRun.length).to.be.greaterThan(0)
    expect(secondRun).to.deep.equal([])
    const rows = await status(pool)
    expect(rows.every((row) => row.applied)).to.equal(true)
  })
})
