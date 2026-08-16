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
  await pool.query('TRUNCATE saga_steps, saga, reservations, payments, shipments, orders, inventory RESTART IDENTITY CASCADE')
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

export async function createItem(overrides = {}) {
  const res = await httpAgent.post('/api/inventory').send({ sku: 'WIDGET-1', available: 10, ...overrides })
  if (res.status !== 201) throw new Error(`createItem(${JSON.stringify(overrides)}) got ${res.status}: ${JSON.stringify(res.body)}`)
  return res.body
}

export const noSleep = () => Promise.resolve()

export const zeroBackoff = { base: 0, cap: 0, random: () => 0 }
