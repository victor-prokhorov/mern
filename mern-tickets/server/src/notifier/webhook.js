import { createCircuitBreaker } from '../circuitBreaker/breaker.js'

const DEFAULT_TIMEOUT_MS = 1000

export class WebhookResponseError extends Error {
  constructor(status) {
    super(`webhook responded ${status}`)
    this.status = status
  }
}

export function isWebhookFailure(err) {
  const status = err.status
  if (typeof status !== 'number') return true
  if (status === 408 || status === 429) return true
  return !(status >= 400 && status < 500)
}

function logTransition(event) {
  console.log(`webhook breaker ${event.from} -> ${event.to} stats=${JSON.stringify(event.stats)}`)
}

export function createNotifier(overrides = {}) {
  const timeoutMs = overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const breaker = createCircuitBreaker({
    now: overrides.now,
    windowMs: overrides.windowMs,
    openMs: overrides.openMs,
    minimumThroughput: overrides.minimumThroughput,
    failureRateThreshold: overrides.failureRateThreshold,
    halfOpenMaxCalls: overrides.halfOpenMaxCalls,
    successesToClose: overrides.successesToClose,
    isFailure: isWebhookFailure,
    onStateChange: logTransition
  })
  async function post(url, event) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) throw new WebhookResponseError(res.status)
    return res
  }
  async function notify(event) {
    const url = overrides.url ?? process.env.TICKET_WEBHOOK_URL
    if (!url) return
    try {
      await breaker.call(() => post(url, event))
    } catch (err) {
      console.error(`webhook notify failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return {
    notify,
    stats: breaker.stats,
    reset: breaker.reset,
    get state() {
      return breaker.state
    }
  }
}

const defaultNotifier = createNotifier()

export const notify = defaultNotifier.notify
export const stats = defaultNotifier.stats
export const reset = defaultNotifier.reset
