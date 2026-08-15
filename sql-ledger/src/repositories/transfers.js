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
  const { rows } = await client.query('SELECT id, reference, status, created_at FROM transfers WHERE id = $1', [id])
  return rows[0] || null
}
