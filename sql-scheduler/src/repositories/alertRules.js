export async function create(client, { kind, threshold, windowSeconds, forEvaluations = 1, cooldownSeconds = 300, channel, active = true }) {
  const { rows } = await client.query(
    `INSERT INTO alert_rules (kind, threshold, window_seconds, for_evaluations, cooldown_seconds, channel, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [kind, threshold, windowSeconds, forEvaluations, cooldownSeconds, channel, active]
  )
  return rows[0]
}

export async function findById(client, id) {
  const { rows } = await client.query('SELECT * FROM alert_rules WHERE id = $1', [id])
  return rows[0] || null
}

export async function listActive(client) {
  const { rows } = await client.query('SELECT * FROM alert_rules WHERE active ORDER BY id')
  return rows
}
