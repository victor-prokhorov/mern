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

export async function adjustBalance(client, id, deltaMinor) {
  await client.query('UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2', [deltaMinor, id])
}

export async function getStoredBalance(client, id) {
  const { rows } = await client.query('SELECT balance_minor FROM accounts WHERE id = $1', [id])
  return rows[0].balance_minor === null ? null : BigInt(rows[0].balance_minor)
}

export async function setBalanceForTest(client, id, amount) {
  await client.query('UPDATE accounts SET balance_minor = $1 WHERE id = $2', [amount, id])
}
