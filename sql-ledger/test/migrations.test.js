import { expect } from 'chai'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import pg from 'pg'
import { pool } from '../src/db.js'
import { migrate, status } from '../src/migrations/runner.js'
import { useTestDb } from './helpers.js'

const { Pool } = pg

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withScratchSchema(fn) {
  const schemaName = `scratch_migrate_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  await pool.query(`CREATE SCHEMA "${schemaName}"`)
  const scratchPool = new Pool({ connectionString: process.env.DATABASE_URL })
  scratchPool.on('connect', (client) => client.query(`SET search_path TO "${schemaName}"`))
  try {
    return await fn(scratchPool)
  } finally {
    await scratchPool.end()
    await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`)
  }
}

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

  it('serialises two concurrent migration runs against the real migrations directory, from scratch, without deadlocking', async () => {
    await withScratchSchema(async (scratchPool) => {
      const [firstRun, secondRun] = await Promise.all([migrate(scratchPool), migrate(scratchPool)])

      const allApplied = [...firstRun, ...secondRun]
      const rows = await status(scratchPool)
      expect(allApplied.length).to.equal(rows.length)
      expect(new Set(allApplied).size).to.equal(allApplied.length)
      expect(rows.every((row) => row.applied)).to.equal(true)
    })
  })

  it('detects and rebuilds an INVALID index left behind by an interrupted CREATE INDEX CONCURRENTLY', async () => {
    await withScratchSchema(async (scratchPool) => {
      const migrationsDir = mkdtempSync(path.join(os.tmpdir(), 'sql-ledger-invalid-index-'))
      writeFileSync(path.join(migrationsDir, '001_create_probe.sql'), 'CREATE TABLE probe (id bigserial PRIMARY KEY, val int)')
      await migrate(scratchPool, { migrationsDir })
      await scratchPool.query('INSERT INTO probe (val) VALUES (1)')
      writeFileSync(
        path.join(migrationsDir, '002_probe_val_index.concurrent.sql'),
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS probe_val_idx ON probe (val)'
      )

      const blocker = await scratchPool.connect()
      await blocker.query('BEGIN')
      await blocker.query('INSERT INTO probe (val) VALUES (1)')
      const builder = await scratchPool.connect()
      const { rows: pidRows } = await builder.query('SELECT pg_backend_pid() AS pid')
      const buildPromise = builder
        .query('CREATE INDEX CONCURRENTLY probe_val_idx ON probe (val)')
        .catch((err) => ({ cancelled: true, message: err.message }))
      await sleep(300)
      const canceller = await scratchPool.connect()
      await canceller.query('SELECT pg_cancel_backend($1)', [pidRows[0].pid])
      const buildResult = await buildPromise
      await blocker.query('COMMIT')
      canceller.release()
      builder.release()
      blocker.release()

      const beforeRepair = await scratchPool.query("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('probe_val_idx')")
      const applied = await migrate(scratchPool, { migrationsDir })
      const afterRepair = await scratchPool.query("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('probe_val_idx')")
      const migrationRows = await status(scratchPool, { migrationsDir })
      rmSync(migrationsDir, { recursive: true, force: true })

      expect(buildResult.cancelled).to.equal(true)
      expect(beforeRepair.rows[0].indisvalid).to.equal(false)
      expect(applied).to.deep.equal(['002_probe_val_index.concurrent.sql'])
      expect(afterRepair.rows[0].indisvalid).to.equal(true)
      expect(migrationRows.every((row) => row.applied)).to.equal(true)
    })
  })
})
