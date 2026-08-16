import { expect } from 'chai'
import http from 'node:http'
import { pool } from '../src/db.js'
import { useTestDb, createScheduleFixture, pastInstant } from './helpers.js'
import { evaluateAllRules, evaluateRulesTick } from '../src/alerting/evaluator.js'
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

describe('alert evaluator', () => {
  useTestDb()

  it('delivers a real notification end to end when a rule fires', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200)
      res.end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await createScheduleFixture({ nextRunAt: pastInstant(120000) })
    const rule = await createRuleFixture({ threshold: 60, channel: `http://127.0.0.1:${port}` })

    await evaluateAllRules(pool)

    server.close()
    const notifications = await notificationsRepo.list(pool)
    const forThisRule = notifications.filter((n) => n.payload.ruleId === rule.id)

    expect(forThisRule).to.have.length(1)
    expect(forThisRule[0].state).to.equal('delivered')
    expect(forThisRule[0].delivered_at).to.not.equal(null)
  })

  it('retries and eventually records a last_error against a real unreachable upstream', async () => {
    await createScheduleFixture({ nextRunAt: pastInstant(120000) })
    const rule = await createRuleFixture({ threshold: 60, channel: 'http://127.0.0.1:1' })

    await evaluateAllRules(pool)

    const notifications = await notificationsRepo.list(pool)
    const forThisRule = notifications.filter((n) => n.payload.ruleId === rule.id)

    expect(forThisRule).to.have.length(1)
    expect(forThisRule[0].state).to.equal('parked')
    expect(forThisRule[0].attempts).to.be.greaterThan(0)
    expect(forThisRule[0].last_error).to.not.equal(null)
  })

  it('is guarded by an advisory lock so two concurrent sweeps do not race', async () => {
    await createScheduleFixture({ nextRunAt: pastInstant(120000) })
    await createRuleFixture({ threshold: 60, channel: 'http://127.0.0.1:1' })

    const [first, second] = await Promise.all([evaluateRulesTick(pool), evaluateRulesTick(pool)])

    const acquiredCount = [first, second].filter((r) => r.acquired).length

    expect(acquiredCount).to.equal(1)
  })

  it('a forced unique-violation race on first creation is absorbed by a savepoint, not thrown', async () => {
    const rule = await createRuleFixture({ forEvaluations: 1 })
    const subject = 'race-subject'
    const clientA = await pool.connect()
    const clientB = await pool.connect()

    try {
      await clientA.query('BEGIN')
      await clientB.query('BEGIN')
      await alertsRepo.create(clientA, {
        ruleId: rule.id,
        subject,
        state: 'firing',
        consecutiveBreaches: 1,
        consecutiveClears: 0,
        occurrences: 1
      })
      const blockedInsert = alertsRepo.createGuarded(clientB, {
        ruleId: rule.id,
        subject,
        state: 'firing',
        consecutiveBreaches: 1,
        consecutiveClears: 0,
        occurrences: 1
      })

      await clientA.query('COMMIT')
      const result = await blockedInsert
      await clientB.query('COMMIT')

      expect(result).to.equal(null)
      const alerts = await alertsRepo.list(pool)
      expect(alerts).to.have.length(1)
    } finally {
      clientA.release()
      clientB.release()
    }
  })
})
