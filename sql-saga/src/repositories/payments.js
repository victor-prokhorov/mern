export async function charge(client, { sagaId, amountMinor }) {
  const { rows } = await client.query(
    `INSERT INTO payments (saga_id, amount_minor, status)
     VALUES ($1, $2, 'charged')
     ON CONFLICT (saga_id) DO NOTHING
     RETURNING id, saga_id, amount_minor, status`,
    [sagaId, amountMinor]
  )
  return rows[0] || null
}

export async function refund(client, sagaId) {
  const { rows } = await client.query(
    `UPDATE payments
     SET status = 'refunded'
     WHERE saga_id = $1 AND status = 'charged'
     RETURNING id, saga_id, amount_minor, status`,
    [sagaId]
  )
  return rows[0] || null
}

export async function findBySaga(client, sagaId) {
  const { rows } = await client.query(
    'SELECT id, saga_id, amount_minor, status FROM payments WHERE saga_id = $1',
    [sagaId]
  )
  return rows[0] || null
}
