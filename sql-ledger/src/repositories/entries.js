export async function create(client, { transferId, accountId, amountMinor }) {
  const { rows } = await client.query(
    'INSERT INTO entries (transfer_id, account_id, amount_minor) VALUES ($1, $2, $3) RETURNING id, transfer_id, account_id, amount_minor, created_at',
    [transferId, accountId, amountMinor]
  )
  return rows[0]
}

export async function findByTransfer(client, transferId) {
  const { rows } = await client.query(
    'SELECT id, transfer_id, account_id, amount_minor, created_at FROM entries WHERE transfer_id = $1 ORDER BY id',
    [transferId]
  )
  return rows
}
