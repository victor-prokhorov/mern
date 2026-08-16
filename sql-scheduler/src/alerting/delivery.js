import * as notificationsRepo from '../repositories/notifications.js'

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function fullJitterBackoffMs(attempt, baseMs, capMs) {
  const window = Math.min(capMs, baseMs * 2 ** attempt)
  return Math.floor(Math.random() * window)
}

export async function attemptDelivery(url, payload, { timeoutMs = 2000, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) throw new Error(`webhook responded ${response.status}`)
  return response
}

export async function deliverWithRetry(pool, notification, options = {}) {
  const {
    url,
    maxAttempts = 5,
    baseMs = 200,
    capMs = 5000,
    timeoutMs = 2000,
    sleep = defaultSleep,
    fetchImpl = fetch
  } = options
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await attemptDelivery(url, notification.payload, { timeoutMs, fetchImpl })
      await notificationsRepo.markDelivered(pool, notification.id)
      return { delivered: true, attempts: attempt + 1, parked: false }
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts - 1
      if (isLastAttempt) {
        await notificationsRepo.markParked(pool, notification.id, err.message)
        return { delivered: false, attempts: attempt + 1, parked: true }
      }
      await notificationsRepo.markFailedAttempt(pool, notification.id, err.message)
      await sleep(fullJitterBackoffMs(attempt, baseMs, capMs))
    }
  }
  return { delivered: false, attempts: maxAttempts, parked: true }
}
