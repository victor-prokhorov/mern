import { expect } from 'chai'
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

  it('serialises two concurrent migration runs against a fresh database via the advisory lock', async () => {
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')

    const [firstRun, secondRun] = await Promise.all([migrate(pool), migrate(pool)])

    const allApplied = [...firstRun, ...secondRun]
    const rows = await status(pool)
    expect(allApplied.length).to.equal(rows.length)
    expect(new Set(allApplied).size).to.equal(allApplied.length)
    expect(rows.every((row) => row.applied)).to.equal(true)
  })
})
