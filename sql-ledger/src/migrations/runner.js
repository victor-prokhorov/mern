import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOCK_KEY = 7392275108
const LOCK_RETRY_MS = 25

function isMigrationFile(name) {
  return /^\d+_.*\.sql$/.test(name)
}

function isConcurrent(name) {
  return name.endsWith('.concurrent.sql')
}

function migrationFiles(migrationsDir) {
  return readdirSync(migrationsDir).filter(isMigrationFile).sort()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireAdvisoryLock(client) {
  for (;;) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [LOCK_KEY])
    if (rows[0].acquired) return
    await sleep(LOCK_RETRY_MS)
  }
}

async function ensureSchemaMigrationsTable(client) {
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  )
}

async function appliedVersions(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version')
  return new Set(rows.map((row) => row.version))
}

async function applyTransactional(client, file, sql) {
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

function extractConcurrentIndexName(sql) {
  const match = sql.match(/CREATE INDEX CONCURRENTLY(?:\s+IF NOT EXISTS)?\s+(\S+)/i)
  return match ? match[1] : null
}

async function repairInvalidIndex(client, sql) {
  const indexName = extractConcurrentIndexName(sql)
  if (!indexName) return
  const { rows } = await client.query('SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)', [indexName])
  if (rows[0] && rows[0].indisvalid === false) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`)
}

async function applyConcurrent(client, file, sql) {
  await repairInvalidIndex(client, sql)
  await client.query(sql)
  await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file])
}

export async function migrate(pool, { migrationsDir = MIGRATIONS_DIR } = {}) {
  const client = await pool.connect()
  try {
    await acquireAdvisoryLock(client)
    try {
      await ensureSchemaMigrationsTable(client)
      const applied = await appliedVersions(client)
      const pending = migrationFiles(migrationsDir).filter((file) => !applied.has(file))
      const results = []
      for (const file of pending) {
        const sql = readFileSync(path.join(migrationsDir, file), 'utf8')
        if (isConcurrent(file)) await applyConcurrent(client, file, sql)
        else await applyTransactional(client, file, sql)
        results.push(file)
      }
      return results
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
    }
  } finally {
    client.release()
  }
}

export async function status(pool, { migrationsDir = MIGRATIONS_DIR } = {}) {
  const client = await pool.connect()
  try {
    await ensureSchemaMigrationsTable(client)
    const applied = await appliedVersions(client)
    return migrationFiles(migrationsDir).map((file) => ({ version: file, applied: applied.has(file) }))
  } finally {
    client.release()
  }
}
