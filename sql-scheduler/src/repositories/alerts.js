export const UNIQUE_VIOLATION = '23505'

export async function findOpen(client, ruleId, subject) {
  const { rows } = await client.query(
    `SELECT * FROM alerts WHERE rule_id = $1 AND subject = $2 AND state <> 'resolved' ORDER BY id DESC LIMIT 1`,
    [ruleId, subject]
  )
  return rows[0] || null
}

export async function create(client, { ruleId, subject, state, consecutiveBreaches, consecutiveClears, occurrences }) {
  const { rows } = await client.query(
    `INSERT INTO alerts (rule_id, subject, state, consecutive_breaches, consecutive_clears, occurrences)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ruleId, subject, state, consecutiveBreaches, consecutiveClears, occurrences]
  )
  return rows[0]
}

export async function createGuarded(client, args) {
  await client.query('SAVEPOINT alert_insert')
  try {
    const alert = await create(client, args)
    await client.query('RELEASE SAVEPOINT alert_insert')
    return alert
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      await client.query('ROLLBACK TO SAVEPOINT alert_insert')
      return null
    }
    throw err
  }
}

export async function updateProgress(client, id, { state, consecutiveBreaches, consecutiveClears, occurrences, lastNotifiedAt, resolvedAt }) {
  const { rows } = await client.query(
    `UPDATE alerts SET state = $1, consecutive_breaches = $2, consecutive_clears = $3, occurrences = $4,
       last_notified_at = COALESCE($5, last_notified_at), resolved_at = $6
     WHERE id = $7 RETURNING *`,
    [state, consecutiveBreaches, consecutiveClears, occurrences, lastNotifiedAt, resolvedAt, id]
  )
  return rows[0]
}

export async function remove(client, id) {
  await client.query('DELETE FROM alerts WHERE id = $1', [id])
}

export async function findById(client, id) {
  const { rows } = await client.query('SELECT * FROM alerts WHERE id = $1', [id])
  return rows[0] || null
}

export async function list(client) {
  const { rows } = await client.query('SELECT * FROM alerts ORDER BY opened_at DESC')
  return rows
}

export async function resolveManually(client, id) {
  const { rows } = await client.query(
    `UPDATE alerts SET state = 'resolved', resolved_at = now() WHERE id = $1 AND state <> 'resolved' RETURNING *`,
    [id]
  )
  return rows[0] || null
}
