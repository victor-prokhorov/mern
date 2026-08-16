export async function create(client, { name, timezone }) {
  const { rows } = await client.query(
    'INSERT INTO accounts (name, timezone) VALUES ($1, $2) RETURNING id, name, timezone, created_at',
    [name, timezone]
  )
  return rows[0]
}

export async function findById(client, id) {
  const { rows } = await client.query('SELECT id, name, timezone, created_at FROM accounts WHERE id = $1', [id])
  return rows[0] || null
}

export async function list(client) {
  const { rows } = await client.query('SELECT id, name, timezone, created_at FROM accounts ORDER BY id')
  return rows
}
