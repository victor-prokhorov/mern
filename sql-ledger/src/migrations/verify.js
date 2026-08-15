const VERIFY_SQL = `
  SELECT
    accounts.id AS account_id,
    accounts.balance_minor AS stored,
    COALESCE(SUM(entries.amount_minor), 0) AS derived
  FROM accounts
  LEFT JOIN entries ON entries.account_id = accounts.id
  GROUP BY accounts.id, accounts.balance_minor
  HAVING accounts.balance_minor IS DISTINCT FROM COALESCE(SUM(entries.amount_minor), 0)
`

export async function verifyBalances(pool) {
  const { rows } = await pool.query(VERIFY_SQL)
  return rows.map((row) => ({
    accountId: row.account_id,
    stored: row.stored === null ? null : BigInt(row.stored),
    derived: BigInt(row.derived)
  }))
}
