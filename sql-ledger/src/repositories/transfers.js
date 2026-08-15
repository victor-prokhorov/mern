const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'

export { UNIQUE_VIOLATION, FOREIGN_KEY_VIOLATION }

export async function create(client, { reference, status }) {
  const { rows } = await client.query(
    'INSERT INTO transfers (reference, status) VALUES ($1, $2) RETURNING id, reference, status, created_at',
    [reference, status]
  )
  return rows[0]
}

export async function findByReference(client, reference) {
  const { rows } = await client.query(
    'SELECT id, reference, status, created_at FROM transfers WHERE reference = $1',
    [reference]
  )
  return rows[0] || null
}

export async function findById(client, id) {
  const { rows } = await client.query('SELECT id, reference, status, created_at, xmin::text AS xmin FROM transfers WHERE id = $1', [id])
  return rows[0] || null
}

export async function findPageKeyset(client, { limit, cursor }) {
  if (!cursor) {
    const { rows } = await client.query(
      'SELECT id, reference, status, created_at FROM transfers ORDER BY created_at DESC, id DESC LIMIT $1',
      [limit]
    )
    return rows
  }
  const { rows } = await client.query(
    'SELECT id, reference, status, created_at FROM transfers WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT $3',
    [cursor.createdAt, cursor.id, limit]
  )
  return rows
}

export async function findPageOffsetDemo(client, { limit, offset }) {
  const { rows } = await client.query(
    'SELECT id, reference, status, created_at FROM transfers ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  )
  return rows
}
