export async function tryAcquire(client, key) {
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [key])
  return rows[0].acquired
}

export async function release(client, key) {
  await client.query('SELECT pg_advisory_unlock($1)', [key])
}
