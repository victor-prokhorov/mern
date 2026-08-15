export async function create(client, { aggregate, aggregateId, type, payload }) {
  const { rows } = await client.query(
    'INSERT INTO outbox (aggregate, aggregate_id, type, payload) VALUES ($1, $2, $3, $4) RETURNING id, aggregate, aggregate_id, type, payload, created_at',
    [aggregate, aggregateId, type, JSON.stringify(payload)]
  )
  return rows[0]
}

export async function claimUnpublished(client, { batchSize, maxAttempts }) {
  const { rows } = await client.query(
    `SELECT id, aggregate, aggregate_id, type, payload, attempts
     FROM outbox
     WHERE published_at IS NULL AND dead_lettered_at IS NULL AND attempts < $1
     ORDER BY id
     FOR UPDATE SKIP LOCKED
     LIMIT $2`,
    [maxAttempts, batchSize]
  )
  return rows
}

export async function markPublished(client, id) {
  await client.query('UPDATE outbox SET published_at = now() WHERE id = $1', [id])
}

export async function recordFailure(client, id, { attempts, lastError }) {
  await client.query('UPDATE outbox SET attempts = $1, last_error = $2 WHERE id = $3', [attempts, lastError, id])
}

export async function deadLetter(client, id, { attempts, lastError }) {
  await client.query(
    'UPDATE outbox SET attempts = $1, last_error = $2, dead_lettered_at = now() WHERE id = $3',
    [attempts, lastError, id]
  )
}

export async function findByAggregate(client, aggregate, aggregateId) {
  const { rows } = await client.query(
    'SELECT id, aggregate, aggregate_id, type, payload, published_at, attempts, last_error, dead_lettered_at FROM outbox WHERE aggregate = $1 AND aggregate_id = $2',
    [aggregate, aggregateId]
  )
  return rows
}
