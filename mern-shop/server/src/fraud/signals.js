import { normalizeEmail } from '../services/blocks.js'

export const NEW_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000
export const VELOCITY_WINDOW_MS = 60 * 60 * 1000
export const VELOCITY_THRESHOLD = 3
export const HIGH_VALUE_THRESHOLD = 200
export const QUANTITY_THRESHOLD = 10

export function NEW_ACCOUNT({ user }) {
  const triggered = Boolean(user?.createdAt) && Date.now() - new Date(user.createdAt).getTime() < NEW_ACCOUNT_WINDOW_MS
  return { code: 'NEW_ACCOUNT', weight: 20, triggered, detail: triggered ? 'account is less than 24 hours old' : null }
}

export function ORDER_VELOCITY({ stats }) {
  const recentOrders = stats?.recentOrderCount ?? 0
  const triggered = recentOrders > VELOCITY_THRESHOLD
  return { code: 'ORDER_VELOCITY', weight: 30, triggered, detail: triggered ? `${recentOrders} orders by this user in the last hour` : null }
}

export function HIGH_VALUE({ cart }) {
  const total = (cart?.items || []).reduce((sum, item) => sum + item.price * item.qty, 0)
  const triggered = total > HIGH_VALUE_THRESHOLD
  return { code: 'HIGH_VALUE', weight: 20, triggered, detail: triggered ? `order total is ${total}` : null }
}

export function QUANTITY_ANOMALY({ cart }) {
  const items = cart?.items || []
  const triggered = items.some((item) => item.qty > QUANTITY_THRESHOLD)
  return { code: 'QUANTITY_ANOMALY', weight: 25, triggered, detail: triggered ? 'a line item quantity exceeds the threshold' : null }
}

export function EMAIL_MISMATCH({ user, customer }) {
  const accountEmail = normalizeEmail(user?.email)
  const checkoutEmail = normalizeEmail(customer?.email)
  const triggered = Boolean(accountEmail) && Boolean(checkoutEmail) && accountEmail !== checkoutEmail
  return { code: 'EMAIL_MISMATCH', weight: 5, triggered, detail: triggered ? 'checkout email differs from the account email' : null }
}

export function BLOCKED_DOMAIN({ stats }) {
  const triggered = Boolean(stats?.isDomainBlocked)
  return { code: 'BLOCKED_DOMAIN', weight: 100, triggered, detail: triggered ? 'checkout email domain is on the blocklist' : null }
}

export const signalFns = [NEW_ACCOUNT, ORDER_VELOCITY, HIGH_VALUE, QUANTITY_ANOMALY, EMAIL_MISMATCH, BLOCKED_DOMAIN]

export function evaluateSignals(context) {
  return signalFns.map((fn) => fn(context))
}
