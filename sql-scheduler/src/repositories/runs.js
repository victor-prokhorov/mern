export const UNIQUE_VIOLATION = '23505'

export async function create(client, { scheduleId, occurrenceAt, status = 'running' }) {
  const { rows } = await client.query(
    'INSERT INTO runs (schedule_id, occurrence_at, status) VALUES ($1, $2, $3) RETURNING id, schedule_id, occurrence_at, started_at, finished_at, status, error',
    [scheduleId, occurrenceAt, status]
  )
  return rows[0]
}

export async function createGuarded(client, { scheduleId, occurrenceAt, status = 'running' }) {
  await client.query('SAVEPOINT run_insert')
  try {
    const run = await create(client, { scheduleId, occurrenceAt, status })
    await client.query('RELEASE SAVEPOINT run_insert')
    return run
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      await client.query('ROLLBACK TO SAVEPOINT run_insert')
      return null
    }
    throw err
  }
}

export async function finish(client, id, { status, error = null }) {
  await client.query('UPDATE runs SET status = $1, error = $2, finished_at = now() WHERE id = $3', [status, error, id])
}

export async function findByScheduleAndOccurrence(client, scheduleId, occurrenceAt) {
  const { rows } = await client.query('SELECT * FROM runs WHERE schedule_id = $1 AND occurrence_at = $2', [scheduleId, occurrenceAt])
  return rows[0] || null
}

export async function listByScheduleId(client, scheduleId) {
  const { rows } = await client.query('SELECT * FROM runs WHERE schedule_id = $1 ORDER BY occurrence_at', [scheduleId])
  return rows
}

export async function listWithLag(client, { limit = 50 } = {}) {
  const { rows } = await client.query(
    `SELECT id, schedule_id, occurrence_at, started_at, finished_at, status, error,
            EXTRACT(EPOCH FROM (started_at - occurrence_at)) AS lag_seconds
     FROM runs ORDER BY occurrence_at DESC LIMIT $1`,
    [limit]
  )
  return rows
}
