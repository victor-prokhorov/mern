import { expect } from 'chai'
import pg from 'pg'
import { pool } from '../src/db.js'
import { migrate, status } from '../src/migrations/runner.js'
import { useTestDb } from './helpers.js'

const { Pool } = pg

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

  it('two concurrent migrate() calls against a fresh schema do not deadlock', async () => {
    const schemaName = `scratch_migrate_${Date.now()}`
    await pool.query(`CREATE SCHEMA "${schemaName}"`)
    const poolA = new Pool({ connectionString: process.env.DATABASE_URL })
    const poolB = new Pool({ connectionString: process.env.DATABASE_URL })
    poolA.on('connect', (client) => client.query(`SET search_path TO "${schemaName}"`))
    poolB.on('connect', (client) => client.query(`SET search_path TO "${schemaName}"`))

    const results = await Promise.all([migrate(poolA), migrate(poolB)])

    await poolA.end()
    await poolB.end()
    await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`)
    const totalApplied = results[0].length + results[1].length
    expect(totalApplied).to.be.greaterThan(0)
  })
})
