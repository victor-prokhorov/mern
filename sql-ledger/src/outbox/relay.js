import * as outboxRepo from '../repositories/outbox.js'

export async function deliver(row, targetUrl) {
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: row.id, aggregate: row.aggregate, aggregateId: row.aggregate_id, type: row.type, payload: row.payload }),
    signal: AbortSignal.timeout(2000)
  })
  if (!res.ok) throw new Error(`upstream responded ${res.status}`)
}

export function backoffMs(attempts, { base = 100, cap = 30000, random = Math.random } = {}) {
  const capped = Math.min(cap, base * 2 ** attempts)
  return random() * capped
}

export async function relayOnce({ pool, targetUrl, batchSize = 10, maxAttempts = 5 }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const rows = await outboxRepo.claimUnpublished(client, { batchSize, maxAttempts })
    for (const row of rows) {
      try {
        await deliver(row, targetUrl)
        await outboxRepo.markPublished(client, row.id)
      } catch (err) {
        const attempts = row.attempts + 1
        const message = err instanceof Error ? err.message : String(err)
        if (attempts >= maxAttempts) await outboxRepo.deadLetter(client, row.id, { attempts, lastError: message })
        else await outboxRepo.recordFailure(client, row.id, { attempts, lastError: message })
      }
    }
    await client.query('COMMIT')
    return rows.length
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
