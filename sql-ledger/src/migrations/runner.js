import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOCK_KEY = 7392275108

function isMigrationFile(name) {
  return /^\d+_.*\.sql$/.test(name)
}

function isConcurrent(name) {
  return name.endsWith('.concurrent.sql')
}

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter(isMigrationFile).sort()
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

async function applyConcurrent(client, file, sql) {
  await client.query(sql)
  await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file])
}

export async function migrate(pool) {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await ensureSchemaMigrationsTable(client)
    const applied = await appliedVersions(client)
    const pending = migrationFiles().filter((file) => !applied.has(file))
    const results = []
    for (const file of pending) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
      if (isConcurrent(file)) await applyConcurrent(client, file, sql)
      else await applyTransactional(client, file, sql)
      results.push(file)
    }
    return results
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
    client.release()
  }
}

export async function status(pool) {
  const client = await pool.connect()
  try {
    await ensureSchemaMigrationsTable(client)
    const applied = await appliedVersions(client)
    return migrationFiles().map((file) => ({ version: file, applied: applied.has(file) }))
  } finally {
    client.release()
  }
}
