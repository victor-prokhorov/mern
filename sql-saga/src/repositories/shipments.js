export async function schedule(client, { sagaId, address }) {
  const { rows } = await client.query(
    `INSERT INTO shipments (saga_id, address)
     VALUES ($1, $2)
     ON CONFLICT (saga_id) DO NOTHING
     RETURNING id, saga_id, address, status`,
    [sagaId, address]
  )
  return rows[0] || null
}

export async function findBySaga(client, sagaId) {
  const { rows } = await client.query(
    'SELECT id, saga_id, address, status FROM shipments WHERE saga_id = $1',
    [sagaId]
  )
  return rows[0] || null
}
