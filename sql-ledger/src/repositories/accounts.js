export async function create(client, { name, currency }) {
  const { rows } = await client.query(
    'INSERT INTO accounts (name, currency) VALUES ($1, $2) RETURNING id, name, currency, created_at',
    [name, currency]
  )
  return rows[0]
}

export async function findById(client, id) {
  const { rows } = await client.query('SELECT id, name, currency, created_at FROM accounts WHERE id = $1', [id])
  return rows[0] || null
}

export async function computeDerivedBalance(client, id) {
  const { rows } = await client.query(
    'SELECT COALESCE(SUM(amount_minor), 0) AS derived FROM entries WHERE account_id = $1',
    [id]
  )
  return BigInt(rows[0].derived)
}
