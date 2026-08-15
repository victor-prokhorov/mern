import pg from 'pg'
import { pool } from '../src/db.js'
import { migrate } from '../src/migrations/runner.js'

const { Pool } = pg

async function ensureTestDatabaseExists() {
  const targetUrl = new URL(process.env.DATABASE_URL)
  const dbName = targetUrl.pathname.slice(1)
  const adminUrl = new URL(process.env.DATABASE_URL)
  adminUrl.pathname = '/postgres'
  const adminPool = new Pool({ connectionString: adminUrl.toString() })
  const { rows } = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
  if (rows.length === 0) await adminPool.query(`CREATE DATABASE "${dbName}"`)
  await adminPool.end()
}

async function truncateAll() {
  await pool.query('TRUNCATE outbox, entries, transfers, accounts RESTART IDENTITY CASCADE')
}

export function useTestDb() {
  before(async () => {
    await ensureTestDatabaseExists()
    await migrate(pool)
  })
  beforeEach(async () => {
    await truncateAll()
  })
}
