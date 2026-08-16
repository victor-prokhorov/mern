export async function get(client, name) {
  const { rows } = await client.query(
    'SELECT replica_name, applied_through, applied_at FROM replica_state WHERE replica_name = $1',
    [name]
  )
  return rows[0] || null
}

export async function list(client) {
  const { rows } = await client.query('SELECT replica_name, applied_through, applied_at FROM replica_state ORDER BY replica_name')
  return rows
}

export async function advance(client, name, { appliedThrough, appliedAt }) {
  await client.query(
    `INSERT INTO replica_state (replica_name, applied_through, applied_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (replica_name)
     DO UPDATE SET applied_through = GREATEST(replica_state.applied_through, EXCLUDED.applied_through), applied_at = EXCLUDED.applied_at`,
    [name, appliedThrough, appliedAt]
  )
}
