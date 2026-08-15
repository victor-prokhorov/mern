export class CircuitBreakerOpenError extends Error {
  constructor(state, retryAfterMs) {
    super(`circuit breaker is ${state}`)
    this.status = 503
    this.state = state
    this.retryAfterMs = Math.max(0, retryAfterMs)
    this.retryAfter = Math.max(1, Math.ceil(this.retryAfterMs / 1000))
  }
}

const CLOSED = 'closed'
const OPEN = 'open'
const HALF_OPEN = 'half-open'

export function createCircuitBreaker(options = {}) {
  const failureRateThreshold = options.failureRateThreshold ?? 0.5
  const minimumThroughput = options.minimumThroughput ?? 5
  const windowMs = options.windowMs ?? 10000
  const openMs = options.openMs ?? 5000
  const halfOpenMaxCalls = options.halfOpenMaxCalls ?? 1
  const successesToClose = options.successesToClose ?? 1
  const now = options.now ?? Date.now
  const isFailure = options.isFailure ?? (() => true)
  const onStateChange = options.onStateChange ?? (() => {})
  let state = CLOSED
  let openedAt = 0
  let outcomes = []
  let halfOpenInFlight = 0
  let halfOpenSuccesses = 0
  function stats() {
    return {
      state,
      total: outcomes.length,
      failures: outcomes.filter((outcome) => !outcome.success).length,
      successes: outcomes.filter((outcome) => outcome.success).length
    }
  }
  function transition(next, t) {
    const previous = state
    state = next
    halfOpenInFlight = 0
    halfOpenSuccesses = 0
    if (next === OPEN) openedAt = t
    if (next === CLOSED) outcomes = []
    if (previous !== next) onStateChange({ from: previous, to: next, stats: stats() })
  }
  function evaluate(t) {
    if (state === OPEN && t - openedAt >= openMs) transition(HALF_OPEN, t)
  }
  function pruneWindow(t) {
    outcomes = outcomes.filter((outcome) => t - outcome.at < windowMs)
  }
  function record(success, t) {
    pruneWindow(t)
    outcomes.push({ at: t, success })
    if (state === CLOSED) {
      const total = outcomes.length
      const failures = outcomes.filter((outcome) => !outcome.success).length
      if (total >= minimumThroughput && failures / total >= failureRateThreshold) transition(OPEN, t)
    } else if (state === HALF_OPEN) {
      if (!success) {
        transition(OPEN, t)
      } else {
        halfOpenSuccesses += 1
        if (halfOpenSuccesses >= successesToClose) transition(CLOSED, t)
      }
    }
  }
  async function call(fn) {
    const t = now()
    evaluate(t)
    if (state === OPEN) throw new CircuitBreakerOpenError(state, openMs - (t - openedAt))
    if (state === HALF_OPEN) {
      if (halfOpenInFlight >= halfOpenMaxCalls) throw new CircuitBreakerOpenError(state, 0)
      halfOpenInFlight += 1
    }
    try {
      const result = await fn()
      record(true, now())
      return result
    } catch (err) {
      if (isFailure(err)) record(false, now())
      throw err
    }
  }
  return {
    call,
    get state() {
      return state
    },
    stats
  }
}
