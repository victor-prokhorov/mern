export async function now(client) {
  const { rows } = await client.query('SELECT now() AS now')
  return rows[0].now
}
