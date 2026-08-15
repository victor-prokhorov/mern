export class CircuitBreakerOpenError extends Error {
  constructor(state, retryAfterMs) {
    super(`circuit breaker is ${state}`)
    this.status = 503
    this.state = state
    this.retryAfterMs = Math.max(0, retryAfterMs)
    this.retryAfter = Math.max(1, Math.ceil(this.retryAfterMs / 1000))
  }
}

export function createCircuitBreaker() {
  throw new Error('not implemented')
}
