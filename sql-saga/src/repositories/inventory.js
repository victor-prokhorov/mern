export async function upsertItem(client, { sku, available }) {
  const { rows } = await client.query(
    `INSERT INTO inventory (sku, available)
     VALUES ($1, $2)
     ON CONFLICT (sku) DO UPDATE SET available = EXCLUDED.available
     RETURNING sku, available, reserved`,
    [sku, available]
  )
  return rows[0]
}

export async function findBySku(client, sku) {
  const { rows } = await client.query('SELECT sku, available, reserved FROM inventory WHERE sku = $1', [sku])
  return rows[0] || null
}

export async function reserve(client, { sagaId, sku, qty }) {
  const { rows } = await client.query(
    `WITH ins AS (
       INSERT INTO reservations (saga_id, sku, qty)
       VALUES ($1, $2, $3)
       ON CONFLICT (saga_id, sku) DO NOTHING
       RETURNING sku, qty
     )
     UPDATE inventory
     SET available = available - ins.qty, reserved = reserved + ins.qty
     FROM ins
     WHERE inventory.sku = ins.sku
     RETURNING inventory.sku, inventory.available, inventory.reserved`,
    [sagaId, sku, qty]
  )
  return rows[0] || null
}

export async function release(client, { sagaId, sku }) {
  const { rows } = await client.query(
    `WITH rel AS (
       UPDATE reservations
       SET released = true
       WHERE saga_id = $1 AND sku = $2 AND released = false
       RETURNING sku, qty
     )
     UPDATE inventory
     SET available = available + rel.qty, reserved = reserved - rel.qty
     FROM rel
     WHERE inventory.sku = rel.sku
     RETURNING inventory.sku, inventory.available, inventory.reserved`,
    [sagaId, sku]
  )
  return rows[0] || null
}
