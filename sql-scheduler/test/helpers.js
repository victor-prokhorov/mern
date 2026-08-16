import pg from 'pg'
import { request } from 'chai-http'
import { pool } from '../src/db.js'
import { migrate } from '../src/migrations/runner.js'
import app from '../src/app.js'
import * as accountsRepo from '../src/repositories/accounts.js'
import * as schedulesRepo from '../src/repositories/schedules.js'

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
  await pool.query('TRUNCATE notifications, alerts, alert_rules, runs, schedules, accounts RESTART IDENTITY CASCADE')
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

export async function createAccountFixture(overrides = {}) {
  return accountsRepo.create(pool, { name: 'acct', timezone: 'UTC', ...overrides })
}

export async function createScheduleFixture(overrides = {}) {
  const account = overrides.accountId ? null : await createAccountFixture()
  return schedulesRepo.create(pool, {
    accountId: account ? account.id : overrides.accountId,
    name: 'schedule',
    cadence: 'every 15m',
    timezone: 'UTC',
    nextRunAt: new Date(),
    catchupPolicy: 'skip',
    active: true,
    ...overrides
  })
}

export function pastInstant(msAgo) {
  return new Date(Date.now() - msAgo)
}
