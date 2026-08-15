import { expect } from 'chai'
import pg from 'pg'
import { pool } from '../src/db.js'
import * as accountsRepo from '../src/repositories/accounts.js'
import { backfillBatch, backfillBalances } from '../src/migrations/backfill.js'
import { verifyBalances } from '../src/migrations/verify.js'
import { migrate, status } from '../src/migrations/runner.js'
import { useTestDb, createAccount, makeTransfer } from './helpers.js'

const { Pool } = pg

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
    await pool.query('ALTER TABLE accounts ADD CONSTRAINT balance_minor_not_null CHECK (balance_minor IS NOT NULL) NOT VALID')
    await pool.query('ALTER TABLE accounts VALIDATE CONSTRAINT balance_minor_not_null')

    expect(firstBatchRowCount).to.equal(1)
    expect(afterFirstBatch.rows.some((row) => row.balance_minor === null)).to.equal(true)
    const finalAlice = await accountsRepo.getStoredBalance(pool, alice.id)
    const finalBob = await accountsRepo.getStoredBalance(pool, bob.id)
    expect(finalAlice).to.equal(-450n)
    expect(finalBob).to.equal(450n)
  })

  it('backfills every remaining batch, not just the first, when more than one batch is needed', async () => {
    await pool.query('ALTER TABLE accounts DROP CONSTRAINT IF EXISTS balance_minor_not_null')
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    const carol = await createAccount({ name: 'carol' })
    await makeTransfer(alice.id, bob.id, 100, 'bf-multi-1')
    await makeTransfer(bob.id, carol.id, 40, 'bf-multi-2')
    await pool.query('UPDATE accounts SET balance_minor = NULL WHERE id IN ($1, $2, $3)', [alice.id, bob.id, carol.id])

    await backfillBalances(pool, { batchSize: 1 })
    await pool.query('ALTER TABLE accounts ADD CONSTRAINT balance_minor_not_null CHECK (balance_minor IS NOT NULL) NOT VALID')
    await pool.query('ALTER TABLE accounts VALIDATE CONSTRAINT balance_minor_not_null')

    const remaining = await pool.query('SELECT id FROM accounts WHERE id IN ($1, $2, $3) AND balance_minor IS NULL', [alice.id, bob.id, carol.id])
    expect(remaining.rows).to.have.length(0)
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

  it('applies the full migration sequence cleanly from scratch, and running it twice is a no-op', async () => {
    const schemaName = `scratch_full_seq_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    const scratchPool = new Pool({ connectionString: process.env.DATABASE_URL })
    scratchPool.on('connect', (client) => client.query(`SET search_path TO "${schemaName}"`))

    const firstRun = await migrate(scratchPool)
    const secondRun = await migrate(scratchPool)
    const rows = await status(scratchPool)
    await scratchPool.end()
    await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`)

    expect(firstRun.length).to.be.greaterThan(0)
    expect(secondRun).to.deep.equal([])
    expect(rows.every((row) => row.applied)).to.equal(true)
  })
})
