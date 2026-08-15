const BACKFILL_SQL = `
  UPDATE accounts SET balance_minor = COALESCE(
    (SELECT SUM(amount_minor) FROM entries WHERE entries.account_id = accounts.id), 0
  )
  WHERE id IN (SELECT id FROM accounts WHERE balance_minor IS NULL ORDER BY id LIMIT $1)
`

export async function backfillBatch(pool, batchSize) {
  const { rowCount } = await pool.query(BACKFILL_SQL, [batchSize])
  return rowCount
}

export async function backfillBalances(pool, { batchSize = 500 } = {}) {
  let totalUpdated = 0
  for (;;) {
    const rowCount = await backfillBatch(pool, batchSize)
    totalUpdated += rowCount
    if (rowCount === 0) break
  }
  return totalUpdated
}
