export async function create(client, { name }) {
  const { rows } = await client.query(
    'INSERT INTO accounts (name) VALUES ($1) RETURNING id, name, created_at',
    [name]
  )
  return rows[0]
}

export async function findById(client, id) {
  const { rows } = await client.query('SELECT id, name, created_at FROM accounts WHERE id = $1', [id])
  return rows[0] || null
}
