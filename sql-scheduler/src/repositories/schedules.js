export async function create(client, { accountId, name, cadence, timezone, nextRunAt, catchupPolicy = 'skip', active = true }) {
  const { rows } = await client.query(
    `INSERT INTO schedules (account_id, name, cadence, timezone, next_run_at, catchup_policy, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, account_id, name, cadence, timezone, next_run_at, last_run_at, catchup_policy, active, created_at`,
    [accountId, name, cadence, timezone, nextRunAt, catchupPolicy, active]
  )
  return rows[0]
}

export async function findById(client, id) {
  const { rows } = await client.query('SELECT * FROM schedules WHERE id = $1', [id])
  return rows[0] || null
}

export async function list(client) {
  const { rows } = await client.query('SELECT * FROM schedules ORDER BY id')
  return rows
}

export async function findDue(client) {
  const { rows } = await client.query('SELECT * FROM schedules WHERE active AND next_run_at <= now() ORDER BY id')
  return rows
}

export async function currentTime(client) {
  const { rows } = await client.query('SELECT now() AS now')
  return rows[0].now
}

export async function updateAfterRun(client, id, { nextRunAt, lastRunAt }) {
  await client.query('UPDATE schedules SET next_run_at = $1, last_run_at = $2 WHERE id = $3', [nextRunAt, lastRunAt, id])
}

export async function setActive(client, id, active) {
  await client.query('UPDATE schedules SET active = $1 WHERE id = $2', [active, id])
}
