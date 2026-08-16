export async function create(client, { accountId, recipient, body }) {
  const { rows } = await client.query(
    'INSERT INTO messages (account_id, recipient, body) VALUES ($1, $2, $3) RETURNING id, account_id, recipient, body, status, sent_at, created_at',
    [accountId, recipient, body]
  )
  return rows[0]
}

export async function findById(client, id) {
  const { rows } = await client.query(
    'SELECT id, account_id, recipient, body, status, sent_at, created_at FROM messages WHERE id = $1',
    [id]
  )
  return rows[0] || null
}

export async function markSent(client, id) {
  const { rows } = await client.query(
    "UPDATE messages SET status = 'sent', sent_at = now() WHERE id = $1 AND status = 'pending' RETURNING id",
    [id]
  )
  return rows.length > 0
}

export async function markFailed(client, id) {
  const { rows } = await client.query(
    "UPDATE messages SET status = 'failed' WHERE id = $1 AND status = 'pending' RETURNING id",
    [id]
  )
  return rows.length > 0
}
