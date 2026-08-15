import { expect } from 'chai'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pool } from '../src/db.js'
import { migrate, status } from '../src/migrations/runner.js'
import { useTestDb } from './helpers.js'

describe('migration runner', () => {
  useTestDb()

  it('applies every migration file and records it in schema_migrations', async () => {
    const rows = await status(pool)

    expect(rows.length).to.be.greaterThan(0)
    expect(rows.every((row) => row.applied)).to.equal(true)
  })

  it('is a no-op when run again', async () => {
    const applied = await migrate(pool)

    expect(applied).to.deep.equal([])
  })

  it('serialises two concurrent migration runs against a scratch set of migrations via the advisory lock', async () => {
    const migrationsDir = mkdtempSync(path.join(os.tmpdir(), 'sql-ledger-migrations-'))
    writeFileSync(path.join(migrationsDir, '999001_lock_test_a.sql'), 'CREATE TABLE lock_test_scratch_a (id int)')
    writeFileSync(path.join(migrationsDir, '999002_lock_test_b.sql'), 'CREATE TABLE lock_test_scratch_b (id int)')

    const [firstRun, secondRun] = await Promise.all([migrate(pool, { migrationsDir }), migrate(pool, { migrationsDir })])

    const allApplied = [...firstRun, ...secondRun]
    const rows = await status(pool, { migrationsDir })
    expect(allApplied.length).to.equal(2)
    expect(new Set(allApplied).size).to.equal(2)
    expect(rows.every((row) => row.applied)).to.equal(true)
    await pool.query('DROP TABLE lock_test_scratch_a, lock_test_scratch_b')
    rmSync(migrationsDir, { recursive: true, force: true })
  })
})
