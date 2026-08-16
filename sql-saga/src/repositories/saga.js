export async function createSaga(client, { type, orderId = null, context = {} }) {
  const { rows } = await client.query(
    `INSERT INTO saga (type, order_id, context)
     VALUES ($1, $2, $3)
     RETURNING id, type, order_id, status, context, created_at, updated_at`,
    [type, orderId, JSON.stringify(context)]
  )
  return rows[0]
}

export async function addStep(client, { sagaId, position, name, kind, maxAttempts = 3 }) {
  const { rows } = await client.query(
    `INSERT INTO saga_steps (saga_id, position, name, kind, max_attempts)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, saga_id, position, name, kind, status, attempts, max_attempts, last_error`,
    [sagaId, position, name, kind, maxAttempts]
  )
  return rows[0]
}

export async function findSaga(client, id) {
  const { rows } = await client.query(
    'SELECT id, type, order_id, status, context, created_at, updated_at FROM saga WHERE id = $1',
    [id]
  )
  return rows[0] || null
}

export async function listSteps(client, sagaId) {
  const { rows } = await client.query(
    `SELECT id, saga_id, position, name, kind, status, attempts, max_attempts, last_error
     FROM saga_steps
     WHERE saga_id = $1
     ORDER BY position ASC`,
    [sagaId]
  )
  return rows
}

export async function setSagaStatus(client, id, status) {
  const { rows } = await client.query(
    `UPDATE saga SET status = $2, updated_at = now() WHERE id = $1
     RETURNING id, status`,
    [id, status]
  )
  return rows[0] || null
}

export async function mergeContext(client, id, patch) {
  const { rows } = await client.query(
    `UPDATE saga SET context = context || $2::jsonb, updated_at = now() WHERE id = $1
     RETURNING id, context`,
    [id, JSON.stringify(patch)]
  )
  return rows[0] || null
}

export async function recordAttempt(client, stepId, error) {
  const { rows } = await client.query(
    `UPDATE saga_steps
     SET attempts = attempts + 1, last_error = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, attempts, max_attempts, last_error`,
    [stepId, error]
  )
  return rows[0] || null
}

export async function setStepStatus(client, stepId, status) {
  const { rows } = await client.query(
    `UPDATE saga_steps SET status = $2, updated_at = now() WHERE id = $1
     RETURNING id, status`,
    [stepId, status]
  )
  return rows[0] || null
}
