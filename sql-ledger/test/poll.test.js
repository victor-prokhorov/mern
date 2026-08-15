import { expect } from 'chai'
import { createGuardedPoll } from '../src/outbox/relay.js'

describe('createGuardedPoll', () => {
  it('skips a tick that fires while the previous one is still in flight', async () => {
    let concurrentCalls = 0
    let maxConcurrent = 0
    let totalCalls = 0
    let resolveFirst
    const fn = async () => {
      concurrentCalls += 1
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls)
      totalCalls += 1
      await new Promise((resolve) => { resolveFirst = resolve })
      concurrentCalls -= 1
    }
    const poll = createGuardedPoll(fn)

    const firstTick = poll()
    const secondTick = poll()
    resolveFirst()

    await Promise.all([firstTick, secondTick])
    expect(maxConcurrent).to.equal(1)
    expect(totalCalls).to.equal(1)
  })

  it('runs again on the next tick once the previous one has finished', async () => {
    let calls = 0
    const fn = async () => {
      calls += 1
    }
    const poll = createGuardedPoll(fn)

    await poll()
    await poll()

    expect(calls).to.equal(2)
  })

  it('clears the guard even when the wrapped function throws', async () => {
    let calls = 0
    const fn = async () => {
      calls += 1
      throw new Error('boom')
    }
    const poll = createGuardedPoll(fn)

    await poll()
    await poll()

    expect(calls).to.equal(2)
  })
})
