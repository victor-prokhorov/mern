import { expect } from 'chai'
import { pool, withTransaction } from '../src/db.js'
import { useTestDb, createAccountFixture, createScheduleFixture, pastInstant } from './helpers.js'
import { tick, runDueSchedules } from '../src/scheduler/tick.js'
import { registerHandler, clearHandlers } from '../src/scheduler/registry.js'
import * as schedulesRepo from '../src/repositories/schedules.js'
import * as runsRepo from '../src/repositories/runs.js'
import { jitterMs } from '../src/scheduler/jitter.js'

describe('scheduler tick', () => {
  useTestDb()

  afterEach(() => {
    clearHandlers()
  })

  it('does nothing for an inactive schedule even when it is overdue', async () => {
    const schedule = await createScheduleFixture({ nextRunAt: pastInstant(60000), active: false })

    await tick(pool)

    const runs = await runsRepo.listByScheduleId(pool, schedule.id)

    expect(runs).to.have.length(0)
  })

  it('executes a due schedule through the registered handler and advances next_run_at on the original grid', async () => {
    let calls = 0
    registerHandler('billing-report', async () => {
      calls += 1
      return { status: 'success' }
    })
    const dueAt = pastInstant(1000)
    const schedule = await createScheduleFixture({ name: 'billing-report', cadence: 'every 15m', nextRunAt: dueAt, catchupPolicy: 'skip' })

    await tick(pool)

    const runs = await runsRepo.listByScheduleId(pool, schedule.id)
    const updated = await schedulesRepo.findById(pool, schedule.id)

    expect(calls).to.equal(1)
    expect(runs).to.have.length(1)
    expect(runs[0].status).to.equal('success')
    expect(new Date(updated.next_run_at).getTime()).to.equal(dueAt.getTime() + 15 * 60 * 1000)
  })

  describe('two instances deciding at once', () => {
    it('two concurrent ticks produce exactly one run for the same due occurrence', async () => {
      registerHandler('race-report', async () => ({ status: 'success' }))
      const dueAt = pastInstant(1000)
      const schedule = await createScheduleFixture({ name: 'race-report', cadence: 'every 15m', nextRunAt: dueAt, catchupPolicy: 'skip' })

      const [first, second] = await Promise.all([tick(pool), tick(pool)])

      const runs = await runsRepo.listByScheduleId(pool, schedule.id)
      const acquiredCount = [first, second].filter((r) => r.acquired).length

      expect(runs).to.have.length(1)
      expect(acquiredCount).to.equal(1)
    })

    it('the unique constraint alone still prevents a duplicate run when the advisory lock is bypassed', async () => {
      registerHandler('unlocked-report', async () => ({ status: 'success' }))
      const dueAt = pastInstant(1000)
      const schedule = await createScheduleFixture({ name: 'unlocked-report', cadence: 'every 15m', nextRunAt: dueAt, catchupPolicy: 'skip' })

      await Promise.all([runDueSchedules(pool), runDueSchedules(pool)])

      const runs = await runsRepo.listByScheduleId(pool, schedule.id)

      expect(runs).to.have.length(1)
    })
  })

  describe('catch-up policies after downtime', () => {
    it('skip runs once and drops the backlog', async () => {
      registerHandler('digest', async () => ({ status: 'success' }))
      const dueAt = pastInstant(6 * 15 * 60 * 1000)
      const schedule = await createScheduleFixture({ name: 'digest', cadence: 'every 15m', nextRunAt: dueAt, catchupPolicy: 'skip' })

      await tick(pool)

      const runs = await runsRepo.listByScheduleId(pool, schedule.id)

      expect(runs).to.have.length(1)
    })

    it('all replays every missed occurrence in order', async () => {
      const seen = []
      registerHandler('replay', async ({ occurrenceAt }) => {
        seen.push(occurrenceAt.getTime())
        return { status: 'success' }
      })
      const dueAt = pastInstant(3 * 15 * 60 * 1000 + 5000)
      const intervalMs = 15 * 60 * 1000
      const expectedOccurrences = [
        dueAt.getTime(),
        dueAt.getTime() + intervalMs,
        dueAt.getTime() + 2 * intervalMs,
        dueAt.getTime() + 3 * intervalMs
      ]
      const schedule = await createScheduleFixture({ name: 'replay', cadence: 'every 15m', nextRunAt: dueAt, catchupPolicy: 'all' })

      await tick(pool)

      const runs = await runsRepo.listByScheduleId(pool, schedule.id)

      expect(seen).to.deep.equal(expectedOccurrences)
      expect(runs.map((r) => new Date(r.occurrence_at).getTime())).to.deep.equal(expectedOccurrences)
    })

    it('none executes nothing but still advances past the missed backlog', async () => {
      let calls = 0
      registerHandler('silent', async () => {
        calls += 1
        return { status: 'success' }
      })
      const dueAt = pastInstant(3 * 15 * 60 * 1000 + 5000)
      const schedule = await createScheduleFixture({ name: 'silent', cadence: 'every 15m', nextRunAt: dueAt, catchupPolicy: 'none' })

      await tick(pool)

      const runs = await runsRepo.listByScheduleId(pool, schedule.id)
      const updated = await schedulesRepo.findById(pool, schedule.id)

      expect(calls).to.equal(0)
      expect(runs).to.have.length(0)
      expect(new Date(updated.next_run_at).getTime()).to.be.greaterThan(Date.now())
    })
  })

  describe('isolation between schedules', () => {
    it('one schedule whose cadence blows up does not stop the tick from processing the others', async () => {
      let healthyCalls = 0
      registerHandler('healthy-report', async () => {
        healthyCalls += 1
        return { status: 'success' }
      })
      const dueAt = pastInstant(1000)
      const poisoned = await createScheduleFixture({ name: 'poisoned-report', cadence: 'daily at 09:00', timezone: 'Not/AZone', nextRunAt: dueAt, catchupPolicy: 'skip' })
      const healthy = await createScheduleFixture({ name: 'healthy-report', cadence: 'daily at 09:00', nextRunAt: dueAt, catchupPolicy: 'skip' })

      await tick(pool)

      const healthyRuns = await runsRepo.listByScheduleId(pool, healthy.id)
      const poisonedRuns = await runsRepo.listByScheduleId(pool, poisoned.id)

      expect(healthyCalls).to.equal(1)
      expect(healthyRuns).to.have.length(1)
      expect(healthyRuns[0].status).to.equal('success')
      expect(poisonedRuns).to.have.length(1)
      expect(poisonedRuns[0].status).to.equal('failure')
      expect(poisonedRuns[0].error).to.not.equal(null)
    })
  })

  describe('drift', () => {
    it('anchors the next occurrence to the scheduled occurrence, not to when the slow run finished', async () => {
      registerHandler('slow-report', async () => {
        await new Promise((resolve) => setTimeout(resolve, 120))
        return { status: 'success' }
      })
      const dueAt = pastInstant(1000)
      const schedule = await createScheduleFixture({ name: 'slow-report', cadence: 'every 15m', nextRunAt: dueAt, catchupPolicy: 'skip' })

      await tick(pool)

      const updated = await schedulesRepo.findById(pool, schedule.id)

      expect(new Date(updated.next_run_at).getTime()).to.equal(dueAt.getTime() + 15 * 60 * 1000)
    })
  })

  describe('jitter', () => {
    it('is deterministic for the same schedule id and period', () => {
      const a = jitterMs(42, 900000)
      const b = jitterMs(42, 900000)

      expect(a).to.equal(b)
    })

    it('never reaches or exceeds the period, so it cannot move an occurrence into the next period', () => {
      for (const periodMs of [1000, 15000, 900000, 86400000]) {
        const value = jitterMs(999, periodMs)

        expect(value).to.be.at.least(0)
        expect(value).to.be.lessThan(periodMs)
      }
    })
  })
})
