import { expect } from 'chai'
import http from 'node:http'
import { pool } from '../src/db.js'
import { useTestDb } from './helpers.js'
import { evaluateMissedRun, evaluateRunFailureRate, evaluateSchedulingLag, MIN_VOLUME_FOR_FAILURE_RATE } from '../src/alerting/rules.js'
import { evaluate } from '../src/alerting/lifecycle.js'
import { deliverWithRetry, fullJitterBackoffMs } from '../src/alerting/delivery.js'
import * as alertRulesRepo from '../src/repositories/alertRules.js'
import * as alertsRepo from '../src/repositories/alerts.js'
import * as notificationsRepo from '../src/repositories/notifications.js'

async function createRuleFixture(overrides = {}) {
  return alertRulesRepo.create(pool, {
    kind: 'missed_run',
    threshold: 60,
    windowSeconds: 300,
    forEvaluations: 1,
    cooldownSeconds: 300,
    channel: 'webhook',
    ...overrides
  })
}

describe('alerting rules: pure predicates', () => {
  it('missed_run breaches once overdue past the threshold', () => {
    const rule = { kind: 'missed_run', threshold: 60 }

    expect(evaluateMissedRun(rule, { overdueSeconds: 30 })).to.equal(false)
    expect(evaluateMissedRun(rule, { overdueSeconds: 61 })).to.equal(true)
  })

  it('run_failure_rate never breaches below the minimum volume, even at 100% failure', () => {
    const rule = { kind: 'run_failure_rate', threshold: 0.5 }

    const belowVolume = evaluateRunFailureRate(rule, { failures: 3, total: MIN_VOLUME_FOR_FAILURE_RATE - 2 })

    expect(belowVolume).to.equal(false)
  })

  it('run_failure_rate breaches once both volume and rate are met', () => {
    const rule = { kind: 'run_failure_rate', threshold: 0.5 }

    const highRateLowVolume = evaluateRunFailureRate(rule, { failures: 3, total: 3 })
    const lowRateHighVolume = evaluateRunFailureRate(rule, { failures: 3, total: 1000 })
    const breaching = evaluateRunFailureRate(rule, { failures: 6, total: 10 })

    expect(highRateLowVolume).to.equal(false)
    expect(lowRateHighVolume).to.equal(false)
    expect(breaching).to.equal(true)
  })

  it('scheduling_lag breaches on lag alone, the case a liveness check misses', () => {
    const missedRunRule = { kind: 'missed_run', threshold: 60 }
    const lagRule = { kind: 'scheduling_lag', threshold: 60 }
    const metrics = { overdueSeconds: 0, lagSeconds: 300 }

    const missedRunResult = evaluateMissedRun(missedRunRule, metrics)
    const lagResult = evaluateSchedulingLag(lagRule, metrics)

    expect(missedRunResult).to.equal(false)
    expect(lagResult).to.equal(true)
  })
})

describe('alert lifecycle', () => {
  useTestDb()

  it('a firing condition creates exactly one alert and one notification', async () => {
    const rule = await createRuleFixture({ forEvaluations: 1 })

    const { alert, notification } = await evaluate(pool, rule, 'schedule:1', true)

    const allAlerts = await alertsRepo.list(pool)
    const allNotifications = await notificationsRepo.list(pool)

    expect(alert.state).to.equal('firing')
    expect(notification).to.not.equal(null)
    expect(allAlerts).to.have.length(1)
    expect(allNotifications).to.have.length(1)
  })

  it('re-evaluating a still-breaching condition updates the existing alert instead of creating a second', async () => {
    const rule = await createRuleFixture({ forEvaluations: 1, cooldownSeconds: 1 })

    await evaluate(pool, rule, 'schedule:2', true)
    const { alert } = await evaluate(pool, rule, 'schedule:2', true, { now: new Date(Date.now() + 2000) })

    const allAlerts = await alertsRepo.list(pool)

    expect(allAlerts).to.have.length(1)
    expect(alert.occurrences).to.equal(2)
  })

  it('a flapping condition does not fire until it breaches for_evaluations times consecutively', async () => {
    const rule = await createRuleFixture({ forEvaluations: 3 })
    const subject = 'schedule:3'

    const afterBreach1 = await evaluate(pool, rule, subject, true)
    const afterClear = await evaluate(pool, rule, subject, false)
    const afterBreach2 = await evaluate(pool, rule, subject, true)
    const afterBreach3 = await evaluate(pool, rule, subject, true)
    const afterBreach4 = await evaluate(pool, rule, subject, true)
    const afterBreach5 = await evaluate(pool, rule, subject, true)

    expect(afterBreach1.alert.state).to.equal('pending')
    expect(afterClear.alert).to.equal(null)
    expect(afterBreach2.alert.state).to.equal('pending')
    expect(afterBreach3.alert.state).to.equal('pending')
    expect(afterBreach4.alert.state).to.equal('firing')
    expect(afterBreach4.notification).to.not.equal(null)
    expect(afterBreach5.notification).to.equal(null)
  })

  it('recovery emits exactly one resolution notification', async () => {
    const rule = await createRuleFixture({ forEvaluations: 2, cooldownSeconds: 1 })
    const subject = 'schedule:4'

    await evaluate(pool, rule, subject, true)
    await evaluate(pool, rule, subject, true)
    const firstClear = await evaluate(pool, rule, subject, false)
    const secondClear = await evaluate(pool, rule, subject, false)

    expect(firstClear.alert.state).to.equal('firing')
    expect(firstClear.notification).to.equal(null)
    expect(secondClear.alert.state).to.equal('resolved')
    expect(secondClear.notification).to.not.equal(null)

    const notifications = await notificationsRepo.list(pool)
    const resolutionNotifications = notifications.filter((n) => n.payload.state === 'resolved')

    expect(resolutionNotifications).to.have.length(1)
  })

  it('cooldown suppresses renotification for a still-firing alert', async () => {
    const rule = await createRuleFixture({ forEvaluations: 1, cooldownSeconds: 3600 })
    const subject = 'schedule:5'

    const first = await evaluate(pool, rule, subject, true)
    const second = await evaluate(pool, rule, subject, true, { now: new Date(Date.now() + 1000) })

    const notifications = await notificationsRepo.list(pool)

    expect(first.notification).to.not.equal(null)
    expect(second.notification).to.equal(null)
    expect(notifications).to.have.length(1)
  })

  it('renotifies once the cooldown has elapsed', async () => {
    const rule = await createRuleFixture({ forEvaluations: 1, cooldownSeconds: 5 })
    const subject = 'schedule:6'

    const first = await evaluate(pool, rule, subject, true)
    const second = await evaluate(pool, rule, subject, true, { now: new Date(Date.now() + 10000) })

    const notifications = await notificationsRepo.list(pool)

    expect(first.notification).to.not.equal(null)
    expect(second.notification).to.not.equal(null)
    expect(notifications).to.have.length(2)
  })
})

describe('notification delivery', () => {
  useTestDb()

  it('delivers successfully on the first attempt against a healthy upstream', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200)
      res.end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const rule = await createRuleFixture()
    const alert = await alertsRepo.create(pool, { ruleId: rule.id, subject: 'x', state: 'firing', consecutiveBreaches: 1, consecutiveClears: 0, occurrences: 1 })
    const notification = await notificationsRepo.create(pool, { alertId: alert.id, channel: 'webhook', payload: { hello: 'world' } })

    const result = await deliverWithRetry(pool, notification, { url: `http://127.0.0.1:${port}`, maxAttempts: 3, baseMs: 1, capMs: 5 })

    server.close()
    const stored = await notificationsRepo.findById(pool, notification.id)

    expect(result.delivered).to.equal(true)
    expect(stored.state).to.equal('delivered')
  })

  it('retries against a failing upstream and eventually parks after the max attempts', async () => {
    let requests = 0
    const server = http.createServer((req, res) => {
      requests += 1
      res.writeHead(500)
      res.end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const rule = await createRuleFixture()
    const alert = await alertsRepo.create(pool, { ruleId: rule.id, subject: 'y', state: 'firing', consecutiveBreaches: 1, consecutiveClears: 0, occurrences: 1 })
    const notification = await notificationsRepo.create(pool, { alertId: alert.id, channel: 'webhook', payload: { hello: 'world' } })

    const result = await deliverWithRetry(pool, notification, { url: `http://127.0.0.1:${port}`, maxAttempts: 3, baseMs: 1, capMs: 5 })

    server.close()
    const stored = await notificationsRepo.findById(pool, notification.id)

    expect(requests).to.equal(3)
    expect(result.delivered).to.equal(false)
    expect(result.parked).to.equal(true)
    expect(stored.state).to.equal('parked')
    expect(stored.attempts).to.equal(3)
  })

  it('full jitter backoff is bounded by the cap and never negative', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const value = fullJitterBackoffMs(attempt, 100, 1000)

      expect(value).to.be.at.least(0)
      expect(value).to.be.lessThan(1000)
    }
  })
})
