export const ORDER_FULFILLMENT = [
  { name: 'reserve_inventory', kind: 'compensatable', maxAttempts: 3 },
  { name: 'charge_payment', kind: 'compensatable', maxAttempts: 3 },
  { name: 'commit_order', kind: 'pivot', maxAttempts: 5 },
  { name: 'confirm_shipping', kind: 'retryable', maxAttempts: 5 }
]
