const FOREIGN_KEY_VIOLATION = '23503'

export { FOREIGN_KEY_VIOLATION }

export async function append(client, { accountId, docKey, body, writtenAt }) {
  const { rows } = await client.query(
    `INSERT INTO changes (account_id, doc_key, body, written_at)
     VALUES ($1, $2, $3, $4)
     RETURNING version, account_id, doc_key, body, written_at`,
    [accountId, docKey, body, writtenAt]
  )
  return rows[0]
}

export async function latestOnPrimary(client, { accountId, docKey }) {
  const { rows } = await client.query(
    `SELECT version, account_id, doc_key, body, written_at FROM changes
     WHERE account_id = $1 AND doc_key = $2
     ORDER BY version DESC LIMIT 1`,
    [accountId, docKey]
  )
  return rows[0] || null
}

export async function latestAsOf(client, { accountId, docKey, position }) {
  const { rows } = await client.query(
    `SELECT version, account_id, doc_key, body, written_at FROM changes
     WHERE account_id = $1 AND doc_key = $2 AND version <= $3
     ORDER BY version DESC LIMIT 1`,
    [accountId, docKey, position]
  )
  return rows[0] || null
}

export async function maxVersionUpTo(client, cutoff) {
  const { rows } = await client.query(
    'SELECT COALESCE(MAX(version), 0)::bigint AS position FROM changes WHERE written_at <= $1',
    [cutoff]
  )
  return Number(rows[0].position)
}

export async function primaryPosition(client) {
  const { rows } = await client.query('SELECT COALESCE(MAX(version), 0)::bigint AS position FROM changes')
  return Number(rows[0].position)
}
