export async function enqueue(client, { kind, payload = {}, runAt = null, priority = 0, maxAttempts = 5 }) {
  const { rows } = await client.query(
    `INSERT INTO jobs (kind, payload, run_at, priority, max_attempts)
     VALUES ($1, $2, COALESCE($3, now()), $4, $5)
     RETURNING id, kind, payload, run_at, priority, status, attempts, max_attempts, locked_at, locked_by, lease_expires_at, last_error, created_at, updated_at`,
    [kind, JSON.stringify(payload), runAt, priority, maxAttempts]
  )
  return rows[0]
}

export async function findById(client, id) {
  const { rows } = await client.query(
    'SELECT id, kind, payload, run_at, priority, status, attempts, max_attempts, locked_at, locked_by, lease_expires_at, last_error, created_at, updated_at FROM jobs WHERE id = $1',
    [id]
  )
  return rows[0] || null
}

export async function claimJobs(client, { workerId, kinds = null, limit = 1, leaseMs = 10000, perAccountLimit = null }) {
  const lockLimit = Math.max(limit * 10, 100)
  const { rows } = await client.query(
    `WITH locked AS (
       SELECT j.id, j.priority, j.run_at, j.payload ->> 'accountId' AS account_key
       FROM jobs j
       WHERE j.status = 'ready'
         AND j.run_at <= now()
         AND ($3::text[] IS NULL OR j.kind = ANY($3))
       ORDER BY j.priority DESC, j.run_at ASC, j.id ASC
       FOR UPDATE OF j SKIP LOCKED
       LIMIT $6
     ),
     running_counts AS (
       SELECT payload ->> 'accountId' AS account_key, count(*) AS running_count
       FROM jobs
       WHERE status = 'running' AND payload ->> 'accountId' IS NOT NULL
       GROUP BY payload ->> 'accountId'
     ),
     ranked AS (
       SELECT locked.id, locked.priority, locked.run_at, locked.account_key,
              ROW_NUMBER() OVER (
                PARTITION BY locked.account_key ORDER BY locked.priority DESC, locked.run_at ASC, locked.id ASC
              ) AS rn
       FROM locked
     ),
     candidates AS (
       SELECT ranked.id, ranked.priority, ranked.run_at
       FROM ranked
       LEFT JOIN running_counts rc ON rc.account_key = ranked.account_key
       WHERE $4::int IS NULL
         OR ranked.account_key IS NULL
         OR ranked.rn <= GREATEST($4 - COALESCE(rc.running_count, 0), 0)
       ORDER BY ranked.priority DESC, ranked.run_at ASC, ranked.id ASC
       LIMIT $2
     )
     UPDATE jobs
     SET status = 'running',
         locked_by = $1,
         locked_at = date_trunc('milliseconds', now()),
         lease_expires_at = now() + ($5 * interval '1 millisecond'),
         updated_at = now()
     FROM candidates
     WHERE jobs.id = candidates.id
     RETURNING jobs.id, jobs.kind, jobs.payload, jobs.run_at, jobs.priority, jobs.status, jobs.attempts,
               jobs.max_attempts, jobs.locked_at, jobs.locked_by, jobs.lease_expires_at, jobs.last_error,
               jobs.created_at, jobs.updated_at`,
    [workerId, limit, kinds, perAccountLimit, leaseMs, lockLimit]
  )
  return rows
}

export async function reapExpired(client, { limit = 100 } = {}) {
  const { rows } = await client.query(
    `UPDATE jobs
     SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead' ELSE 'ready' END,
         attempts = attempts + 1,
         last_error = 'lease expired',
         locked_by = NULL,
         locked_at = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status = 'running' AND lease_expires_at < now()
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     RETURNING id, kind, payload, status, attempts, max_attempts`,
    [limit]
  )
  return rows
}

export async function heartbeat(client, { jobId, workerId, leaseMs }) {
  const { rows } = await client.query(
    `UPDATE jobs
     SET lease_expires_at = now() + ($3 * interval '1 millisecond'), updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND status = 'running'
     RETURNING id, lease_expires_at`,
    [jobId, workerId, leaseMs]
  )
  return rows[0] || null
}

export async function completeJob(client, { jobId, workerId, lockedAt }) {
  const { rows } = await client.query(
    `UPDATE jobs
     SET status = 'done', updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND locked_at = $3 AND status = 'running'
     RETURNING id`,
    [jobId, workerId, lockedAt]
  )
  return rows.length > 0
}

export async function failJob(client, { jobId, workerId, lockedAt, error, delayMs, dead }) {
  if (dead) {
    const { rows } = await client.query(
      `UPDATE jobs
       SET status = 'dead', attempts = attempts + 1, last_error = $4,
           locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND locked_by = $2 AND locked_at = $3 AND status = 'running'
       RETURNING id`,
      [jobId, workerId, lockedAt, error]
    )
    return rows.length > 0
  }
  const { rows } = await client.query(
    `UPDATE jobs
     SET status = 'ready', run_at = now() + ($5 * interval '1 millisecond'), attempts = attempts + 1, last_error = $4,
         locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND locked_at = $3 AND status = 'running'
     RETURNING id`,
    [jobId, workerId, lockedAt, error, delayMs]
  )
  return rows.length > 0
}

export async function releaseLease(client, { jobId, workerId, lockedAt }) {
  const { rows } = await client.query(
    `UPDATE jobs
     SET status = 'ready', locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND locked_at = $3 AND status = 'running'
     RETURNING id`,
    [jobId, workerId, lockedAt]
  )
  return rows.length > 0
}

export async function listJobs(client, { status = null, kind = null, limit = 50, offset = 0 } = {}) {
  const { rows } = await client.query(
    `SELECT id, kind, payload, run_at, priority, status, attempts, max_attempts, locked_at, locked_by,
            lease_expires_at, last_error, created_at, updated_at
     FROM jobs
     WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR kind = $2)
     ORDER BY id DESC
     LIMIT $3 OFFSET $4`,
    [status, kind, limit, offset]
  )
  return rows
}

export async function retryDead(client, id) {
  const { rows } = await client.query(
    `UPDATE jobs
     SET status = 'ready', attempts = 0, last_error = NULL, run_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'dead'
     RETURNING id, kind, payload, run_at, priority, status, attempts, max_attempts, last_error, created_at, updated_at`,
    [id]
  )
  return rows[0] || null
}

export async function countByAccountAndStatus(client, { accountId, status }) {
  const { rows } = await client.query(
    "SELECT count(*)::int AS count FROM jobs WHERE payload ->> 'accountId' = $1 AND status = $2",
    [String(accountId), status]
  )
  return rows[0].count
}
