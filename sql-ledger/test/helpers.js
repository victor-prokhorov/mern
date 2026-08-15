import pg from 'pg'
import { request } from 'chai-http'
import { pool } from '../src/db.js'
import { migrate } from '../src/migrations/runner.js'
import app from '../src/app.js'

const { Pool } = pg

export const httpAgent = request.agent(app)

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

export async function createAccount(overrides = {}) {
  const res = await httpAgent.post('/api/accounts').send({ name: 'acc', currency: 'USD', ...overrides })
  if (res.status !== 201) throw new Error(`createAccount(${JSON.stringify(overrides)}) got ${res.status}: ${JSON.stringify(res.body)}`)
  return res.body
}

export async function makeTransfer(fromAccountId, toAccountId, amountMinor, reference) {
  const res = await httpAgent.post('/api/transfers').send({ reference, fromAccountId, toAccountId, amountMinor })
  if (res.status !== 201) throw new Error(`makeTransfer(${reference}) got ${res.status}: ${JSON.stringify(res.body)}`)
  return res.body
}
