export async function create(client, { alertId, channel, payload }) {
  const { rows } = await client.query(
    `INSERT INTO notifications (alert_id, channel, payload) VALUES ($1, $2, $3) RETURNING *`,
    [alertId, channel, payload]
  )
  return rows[0]
}

export async function markDelivered(client, id) {
  await client.query(`UPDATE notifications SET state = 'delivered', delivered_at = now() WHERE id = $1`, [id])
}

export async function markFailedAttempt(client, id, error) {
  await client.query(
    `UPDATE notifications SET attempts = attempts + 1, last_error = $1 WHERE id = $2`,
    [error, id]
  )
}

export async function markParked(client, id, error) {
  await client.query(
    `UPDATE notifications SET state = 'parked', attempts = attempts + 1, last_error = $1 WHERE id = $2`,
    [error, id]
  )
}

export async function claimPending(client, limit) {
  const { rows } = await client.query(
    `SELECT * FROM notifications WHERE state = 'pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1`,
    [limit]
  )
  return rows
}

export async function findById(client, id) {
  const { rows } = await client.query('SELECT * FROM notifications WHERE id = $1', [id])
  return rows[0] || null
}

export async function listByAlertId(client, alertId) {
  const { rows } = await client.query('SELECT * FROM notifications WHERE alert_id = $1 ORDER BY id', [alertId])
  return rows
}

export async function list(client) {
  const { rows } = await client.query('SELECT * FROM notifications ORDER BY id DESC')
  return rows
}
