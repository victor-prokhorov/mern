import { expect } from 'chai'
import { pool, withTransaction } from '../src/db.js'
import * as sagaRepo from '../src/repositories/saga.js'
import * as inventoryRepo from '../src/repositories/inventory.js'
import * as paymentsRepo from '../src/repositories/payments.js'
import { startSaga, runSaga } from '../src/saga/engine.js'
import { useTestDb, noSleep, zeroBackoff } from './helpers.js'

async function makeSaga(definition, context = {}) {
  return withTransaction(async (client) => startSaga(client, { type: 'test', orderId: null, context, definition }))
}

function run(sagaId, registry) {
  return runSaga(pool, { sagaId, registry, backoff: zeroBackoff, sleep: noSleep })
}

async function steps(sagaId) {
  return sagaRepo.listSteps(pool, sagaId)
}

describe('saga engine', () => {
  useTestDb()

  it('happy path: every step succeeds and the saga ends completed', async () => {
    const saga = await makeSaga([
      { name: 'a', kind: 'compensatable', maxAttempts: 3 },
      { name: 'b', kind: 'compensatable', maxAttempts: 3 },
      { name: 'p', kind: 'pivot', maxAttempts: 3 },
      { name: 'c', kind: 'retryable', maxAttempts: 3 }
    ])
    const order = []
    const registry = new Map([
      ['a', { action: async () => order.push('a'), compensate: async () => order.push('~a') }],
      ['b', { action: async () => order.push('b'), compensate: async () => order.push('~b') }],
      ['p', { action: async () => order.push('p') }],
      ['c', { action: async () => order.push('c') }]
    ])

    const result = await run(saga.id, registry)

    expect(result.status).to.equal('completed')
    expect(order).to.deep.equal(['a', 'b', 'p', 'c'])
    expect((await steps(saga.id)).map((s) => s.status)).to.deep.equal(['done', 'done', 'done', 'done'])
  })

  it('a compensatable step failing after prior steps succeeded compensates them in reverse and ends compensated (aborted)', async () => {
    const saga = await makeSaga([
      { name: 'a', kind: 'compensatable', maxAttempts: 2 },
      { name: 'b', kind: 'compensatable', maxAttempts: 2 },
      { name: 'boom', kind: 'compensatable', maxAttempts: 2 }
    ])
    const compensations = []
    const registry = new Map([
      ['a', { action: async () => {}, compensate: async () => compensations.push('a') }],
      ['b', { action: async () => {}, compensate: async () => compensations.push('b') }],
      ['boom', { action: async () => { throw new Error('payment declined') }, compensate: async () => compensations.push('boom') }]
    ])

    const result = await run(saga.id, registry)

    expect(result.status).to.equal('compensated')
    expect(compensations).to.deep.equal(['b', 'a'])
    const statuses = Object.fromEntries((await steps(saga.id)).map((s) => [s.name, s.status]))
    expect(statuses).to.deep.equal({ a: 'compensated', b: 'compensated', boom: 'failed' })
  })

  it('a step after the pivot is retried on failure and never compensated: it succeeds within budget and the saga still completes', async () => {
    const saga = await makeSaga([
      { name: 'a', kind: 'compensatable', maxAttempts: 3 },
      { name: 'p', kind: 'pivot', maxAttempts: 3 },
      { name: 'flaky', kind: 'retryable', maxAttempts: 5 }
    ])
    const compensations = []
    let flakyCalls = 0
    const registry = new Map([
      ['a', { action: async () => {}, compensate: async () => compensations.push('a') }],
      ['p', { action: async () => {} }],
      ['flaky', { action: async () => { flakyCalls += 1; if (flakyCalls < 3) throw new Error('shipping API 503') } }]
    ])

    const result = await run(saga.id, registry)

    expect(result.status).to.equal('completed')
    expect(compensations).to.deep.equal([])
    expect(flakyCalls).to.equal(3)
    const flaky = (await steps(saga.id)).find((s) => s.name === 'flaky')
    expect(flaky.status).to.equal('done')
    expect(flaky.attempts).to.equal(2)
  })

  it('a permanently-failing step past the pivot ends the saga failed (forward-stuck) and never triggers compensation of the completed compensatable steps', async () => {
    const saga = await makeSaga([
      { name: 'a', kind: 'compensatable', maxAttempts: 2 },
      { name: 'p', kind: 'pivot', maxAttempts: 2 },
      { name: 'stuck', kind: 'retryable', maxAttempts: 2 }
    ])
    const compensations = []
    const registry = new Map([
      ['a', { action: async () => {}, compensate: async () => compensations.push('a') }],
      ['p', { action: async () => {} }],
      ['stuck', { action: async () => { throw new Error('carrier permanently down') } }]
    ])

    const result = await run(saga.id, registry)

    expect(result.status).to.equal('failed')
    expect(compensations).to.deep.equal([])
    const statuses = Object.fromEntries((await steps(saga.id)).map((s) => [s.name, s.status]))
    expect(statuses).to.deep.equal({ a: 'done', p: 'done', stuck: 'failed' })
  })

  it('retry budget: a flaky compensatable step succeeds within budget without compensating', async () => {
    const saga = await makeSaga([{ name: 'a', kind: 'compensatable', maxAttempts: 3 }])
    const compensations = []
    let calls = 0
    const registry = new Map([
      ['a', { action: async () => { calls += 1; if (calls < 2) throw new Error('transient') }, compensate: async () => compensations.push('a') }]
    ])

    const result = await run(saga.id, registry)

    expect(result.status).to.equal('completed')
    expect(calls).to.equal(2)
    expect(compensations).to.deep.equal([])
  })

  it('retry budget: a permanently-failing compensatable step exhausts exactly maxAttempts tries, then aborts and compensates the step that had succeeded', async () => {
    const saga = await makeSaga([
      { name: 'setup', kind: 'compensatable', maxAttempts: 3 },
      { name: 'a', kind: 'compensatable', maxAttempts: 3 }
    ])
    const compensations = []
    let calls = 0
    const registry = new Map([
      ['setup', { action: async () => {}, compensate: async () => compensations.push('setup') }],
      ['a', { action: async () => { calls += 1; throw new Error('down for good') }, compensate: async () => compensations.push('a') }]
    ])

    const result = await run(saga.id, registry)

    expect(result.status).to.equal('compensated')
    expect(calls).to.equal(3)
    const statuses = Object.fromEntries((await steps(saga.id)).map((s) => [s.name, { status: s.status, attempts: s.attempts, last_error: s.last_error }]))
    expect(statuses.a).to.deep.equal({ status: 'failed', attempts: 3, last_error: 'down for good' })
    expect(statuses.setup.status).to.equal('compensated')
    expect(compensations).to.deep.equal(['setup'])
  })

  it('resumes from persisted state: a step already done is not re-executed, and the crashed-orchestrator picks up where it left off', async () => {
    const saga = await makeSaga([
      { name: 'a', kind: 'compensatable', maxAttempts: 3 },
      { name: 'b', kind: 'compensatable', maxAttempts: 3 },
      { name: 'c', kind: 'retryable', maxAttempts: 3 }
    ])
    const persisted = await steps(saga.id)
    await sagaRepo.setStepStatus(pool, persisted[0].id, 'done')
    const calls = []
    const registry = new Map([
      ['a', { action: async () => calls.push('a'), compensate: async () => {} }],
      ['b', { action: async () => calls.push('b'), compensate: async () => {} }],
      ['c', { action: async () => calls.push('c') }]
    ])

    const result = await run(saga.id, registry)

    expect(result.status).to.equal('completed')
    expect(calls).to.deep.equal(['b', 'c'])
  })

  it('re-running an already-completed saga is a no-op: no step action runs a second time', async () => {
    const saga = await makeSaga([{ name: 'a', kind: 'retryable', maxAttempts: 3 }])
    let calls = 0
    const registry = new Map([['a', { action: async () => { calls += 1 } }]])
    await run(saga.id, registry)

    const second = await run(saga.id, registry)

    expect(second.status).to.equal('completed')
    expect(calls).to.equal(1)
  })

  it('re-running a saga wedged in compensating resumes compensation and never re-enters the forward path', async () => {
    const saga = await makeSaga([
      { name: 'a', kind: 'compensatable', maxAttempts: 1 },
      { name: 'b', kind: 'compensatable', maxAttempts: 1 },
      { name: 'boom', kind: 'compensatable', maxAttempts: 1 }
    ])
    const compensations = []
    let boomActions = 0
    let aCompensations = 0
    const registry = new Map([
      ['a', { action: async () => {}, compensate: async () => { aCompensations += 1; if (aCompensations === 1) throw new Error('release API down'); compensations.push('a') } }],
      ['b', { action: async () => {}, compensate: async () => compensations.push('b') }],
      ['boom', { action: async () => { boomActions += 1; if (boomActions === 1) throw new Error('payment declined') }, compensate: async () => compensations.push('boom') }]
    ])
    await run(saga.id, registry).catch(() => {})
    expect((await sagaRepo.findSaga(pool, saga.id)).status).to.equal('compensating')

    const result = await run(saga.id, registry)

    expect(result.status).to.equal('compensated')
    expect(boomActions).to.equal(1)
    expect(compensations).to.deep.equal(['b', 'a'])
    const statuses = Object.fromEntries((await steps(saga.id)).map((s) => [s.name, s.status]))
    expect(statuses).to.deep.equal({ a: 'compensated', b: 'compensated', boom: 'failed' })
  })

  it('domain steps and compensations are idempotent under at-least-once execution: replaying reserve, release and charge is a no-op', async () => {
    await inventoryRepo.upsertItem(pool, { sku: 'X', available: 10 })

    await inventoryRepo.reserve(pool, { sagaId: 1, sku: 'X', qty: 3 })
    await inventoryRepo.reserve(pool, { sagaId: 1, sku: 'X', qty: 3 })
    const afterReserve = await inventoryRepo.findBySku(pool, 'X')
    await inventoryRepo.release(pool, { sagaId: 1, sku: 'X' })
    await inventoryRepo.release(pool, { sagaId: 1, sku: 'X' })
    const afterRelease = await inventoryRepo.findBySku(pool, 'X')
    await paymentsRepo.charge(pool, { sagaId: 1, amountMinor: 500 })
    await paymentsRepo.charge(pool, { sagaId: 1, amountMinor: 500 })
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM payments WHERE saga_id = 1')

    expect(afterReserve).to.deep.include({ sku: 'X', available: 7, reserved: 3 })
    expect(afterRelease).to.deep.include({ sku: 'X', available: 10, reserved: 0 })
    expect(rows[0].n).to.equal(1)
  })
})
