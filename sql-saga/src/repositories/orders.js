export async function create(client, { sku, qty, amountMinor, address }) {
  const { rows } = await client.query(
    `INSERT INTO orders (sku, qty, amount_minor, address)
     VALUES ($1, $2, $3, $4)
     RETURNING id, sku, qty, amount_minor, address, status, created_at, updated_at`,
    [sku, qty, amountMinor, address]
  )
  return rows[0]
}

export async function findById(client, id) {
  const { rows } = await client.query(
    'SELECT id, sku, qty, amount_minor, address, status, created_at, updated_at FROM orders WHERE id = $1',
    [id]
  )
  return rows[0] || null
}

export async function place(client, id) {
  const { rows } = await client.query(
    `UPDATE orders
     SET status = 'placed', updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'placed')
     RETURNING id, sku, qty, amount_minor, address, status`,
    [id]
  )
  return rows[0] || null
}

export async function cancel(client, id) {
  const { rows } = await client.query(
    `UPDATE orders
     SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'cancelled')
     RETURNING id, status`,
    [id]
  )
  return rows[0] || null
}
