import { expect } from 'chai'
import { createCircuitBreaker, CircuitBreakerOpenError } from '../src/circuitBreaker/breaker.js'

async function captureRejection(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err
  }
}

describe('circuit breaker', () => {
  it('stays closed while under the failure-rate threshold', async () => {
    let currentTime = 0
    const breaker = createCircuitBreaker({ now: () => currentTime })

    for (let i = 0; i < 9; i++) await captureRejection(breaker.call(() => {
      if (i % 3 === 0) throw new Error('boom')
      return 'ok'
    }))

    expect(breaker.state).to.equal('closed')
  })

  it('does not trip below minimumThroughput even at a 100% failure rate', async () => {
    let currentTime = 0
    const breaker = createCircuitBreaker({ now: () => currentTime, minimumThroughput: 5 })

    for (let i = 0; i < 4; i++) await captureRejection(breaker.call(() => { throw new Error('boom') }))

    expect(breaker.state).to.equal('closed')
  })

  it('trips once both threshold and throughput are met', async () => {
    let currentTime = 0
    const breaker = createCircuitBreaker({ now: () => currentTime, minimumThroughput: 5, failureRateThreshold: 0.5 })

    for (let i = 0; i < 5; i++) await captureRejection(breaker.call(() => {
      if (i < 3) throw new Error('boom')
      return 'ok'
    }))

    expect(breaker.state).to.equal('open')
  })

  it('rejects immediately while open, with the wrapped function never invoked', async () => {
    let currentTime = 0
    const breaker = createCircuitBreaker({ now: () => currentTime, minimumThroughput: 1, failureRateThreshold: 0.5 })
    await captureRejection(breaker.call(() => { throw new Error('boom') }))
    let invoked = false

    const err = await captureRejection(breaker.call(() => { invoked = true; return 'ok' }))

    expect(err).to.be.instanceOf(CircuitBreakerOpenError)
    expect(invoked).to.equal(false)
  })

  it('moves to half-open after openMs on the next call, not before', async () => {
    let currentTime = 0
    const breaker = createCircuitBreaker({ now: () => currentTime, minimumThroughput: 1, failureRateThreshold: 0.5, openMs: 5000 })
    await captureRejection(breaker.call(() => { throw new Error('boom') }))
    currentTime = 4999
    let invokedTooEarly = false
    await captureRejection(breaker.call(() => { invokedTooEarly = true; return 'ok' }))
    currentTime = 5000
    let observedState = null

    await breaker.call(() => { observedState = breaker.state; return 'ok' })

    expect(invokedTooEarly).to.equal(false)
    expect(observedState).to.equal('half-open')
  })

  it('a successful trial closes it and clears the window', async () => {
    let currentTime = 0
    const breaker = createCircuitBreaker({ now: () => currentTime, minimumThroughput: 1, failureRateThreshold: 0.5, openMs: 5000 })
    await captureRejection(breaker.call(() => { throw new Error('boom') }))
    currentTime = 5000

    await breaker.call(() => 'ok')

    expect(breaker.state).to.equal('closed')
    expect(breaker.stats().total).to.equal(0)
  })

  it('a failed trial re-opens it and restarts the clock', async () => {
    let currentTime = 0
    const breaker = createCircuitBreaker({ now: () => currentTime, minimumThroughput: 1, failureRateThreshold: 0.5, openMs: 5000 })
    await captureRejection(breaker.call(() => { throw new Error('boom') }))
    currentTime = 5000
    await captureRejection(breaker.call(() => { throw new Error('boom again') }))
    currentTime = 9999
    let invokedTooEarly = false

    await captureRejection(breaker.call(() => { invokedTooEarly = true; return 'ok' }))

    expect(invokedTooEarly).to.equal(false)
    expect(breaker.state).to.equal('open')
  })

  it('admits only halfOpenMaxCalls trials concurrently', async () => {
    let currentTime = 0
    const breaker = createCircuitBreaker({ now: () => currentTime, minimumThroughput: 1, failureRateThreshold: 0.5, openMs: 5000, halfOpenMaxCalls: 1 })
    await captureRejection(breaker.call(() => { throw new Error('boom') }))
    currentTime = 5000
    let resolveFirst
    const slow = () => new Promise((resolve) => { resolveFirst = resolve })
    let secondInvoked = false
    const fast = () => { secondInvoked = true; return 'ok' }

    const firstAttempt = breaker.call(slow)
    const secondResult = await captureRejection(breaker.call(fast))
    resolveFirst('done')
    await firstAttempt

    expect(secondResult).to.be.instanceOf(CircuitBreakerOpenError)
    expect(secondResult.state).to.equal('half-open')
    expect(secondInvoked).to.equal(false)
  })

  it('counts a timeout as a failure', async () => {
    let currentTime = 0
    const breaker = createCircuitBreaker({ now: () => currentTime, minimumThroughput: 3, failureRateThreshold: 0.5 })
    const timeout = () => {
      const err = new Error('timeout')
      err.name = 'AbortError'
      throw err
    }

    for (let i = 0; i < 3; i++) await captureRejection(breaker.call(timeout))

    expect(breaker.state).to.equal('open')
  })

  it('does not count an error rejected by isFailure', async () => {
    let currentTime = 0
    const breaker = createCircuitBreaker({ now: () => currentTime, minimumThroughput: 1, failureRateThreshold: 0.5, isFailure: (err) => err.status !== 400 })
    const badRequest = () => {
      const err = new Error('bad request')
      err.status = 400
      throw err
    }

    for (let i = 0; i < 5; i++) await captureRejection(breaker.call(badRequest))

    expect(breaker.state).to.equal('closed')
    expect(breaker.stats().failures).to.equal(0)
    expect(breaker.stats().total).to.equal(0)
  })

  it('reports the numbers behind the decision from stats()', async () => {
    let currentTime = 0
    const breaker = createCircuitBreaker({ now: () => currentTime, minimumThroughput: 10, failureRateThreshold: 0.5 })
    for (let i = 0; i < 3; i++) await captureRejection(breaker.call(() => { throw new Error('boom') }))
    for (let i = 0; i < 2; i++) await breaker.call(() => 'ok')

    const stats = breaker.stats()

    expect(stats).to.deep.equal({ state: 'closed', total: 5, failures: 3, successes: 2 })
  })
})
