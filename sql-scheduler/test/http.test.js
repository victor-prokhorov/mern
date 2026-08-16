import { expect } from 'chai'
import { pool } from '../src/db.js'
import { useTestDb, httpAgent } from './helpers.js'
import * as runsRepo from '../src/repositories/runs.js'
import * as alertRulesRepo from '../src/repositories/alertRules.js'
import * as alertsRepo from '../src/repositories/alerts.js'

describe('HTTP surface', () => {
  useTestDb()

  it('creates an account', async () => {
    const res = await httpAgent.post('/api/accounts').send({ name: 'Acme', timezone: 'Europe/Paris' })

    expect(res.status).to.equal(201)
    expect(res.body.name).to.equal('Acme')
    expect(res.body.timezone).to.equal('Europe/Paris')
  })

  it('rejects an account with no name', async () => {
    const res = await httpAgent.post('/api/accounts').send({ timezone: 'Europe/Paris' })

    expect(res.status).to.equal(400)
  })

  it('creates a schedule for an existing account and returns its computed next_run_at', async () => {
    const account = (await httpAgent.post('/api/accounts').send({ name: 'Acme', timezone: 'Europe/Paris' })).body

    const res = await httpAgent.post('/api/schedules').send({
      accountId: account.id,
      name: 'daily-digest',
      cadence: 'daily at 09:00',
      timezone: 'Europe/Paris',
      catchupPolicy: 'skip'
    })

    expect(res.status).to.equal(201)
    expect(res.body.cadence).to.equal('daily at 09:00')
    expect(res.body.next_run_at).to.not.equal(null)
  })

  it('rejects a schedule with an invalid cadence string', async () => {
    const account = (await httpAgent.post('/api/accounts').send({ name: 'Acme', timezone: 'Europe/Paris' })).body

    const res = await httpAgent.post('/api/schedules').send({
      accountId: account.id,
      name: 'bad',
      cadence: 'whenever',
      timezone: 'Europe/Paris'
    })

    expect(res.status).to.equal(400)
  })

  it('rejects a schedule for a non-existent account', async () => {
    const res = await httpAgent.post('/api/schedules').send({
      accountId: 999999,
      name: 'orphan',
      cadence: 'every 15m',
      timezone: 'UTC'
    })

    expect(res.status).to.equal(400)
  })

  it('lists schedules', async () => {
    const account = (await httpAgent.post('/api/accounts').send({ name: 'Acme', timezone: 'UTC' })).body
    await httpAgent.post('/api/schedules').send({ accountId: account.id, name: 's1', cadence: 'every 15m', timezone: 'UTC' })

    const res = await httpAgent.get('/api/schedules')

    expect(res.status).to.equal(200)
    expect(res.body.schedules).to.have.length(1)
  })

  it('lists runs with their computed lag', async () => {
    const account = (await httpAgent.post('/api/accounts').send({ name: 'Acme', timezone: 'UTC' })).body
    const schedule = (await httpAgent.post('/api/schedules').send({ accountId: account.id, name: 's1', cadence: 'every 15m', timezone: 'UTC' })).body
    const occurrenceAt = new Date(Date.now() - 60000)
    const run = await runsRepo.create(pool, { scheduleId: schedule.id, occurrenceAt })
    await runsRepo.setStartedAtForSeed(pool, run.id, new Date(occurrenceAt.getTime() + 5000))

    const res = await httpAgent.get('/api/runs')

    expect(res.status).to.equal(200)
    expect(res.body.runs).to.have.length(1)
    expect(Number(res.body.runs[0].lag_seconds)).to.equal(5)
  })

  it('lists alerts and allows manually resolving one', async () => {
    const rule = await alertRulesRepo.create(pool, {
      kind: 'missed_run',
      threshold: 60,
      windowSeconds: 300,
      forEvaluations: 1,
      cooldownSeconds: 300,
      channel: 'webhook'
    })
    const alert = await alertsRepo.create(pool, {
      ruleId: rule.id,
      subject: 'schedule:1',
      state: 'firing',
      consecutiveBreaches: 1,
      consecutiveClears: 0,
      occurrences: 1
    })

    const listRes = await httpAgent.get('/api/alerts')
    const resolveRes = await httpAgent.post(`/api/alerts/${alert.id}/resolve`)
    const resolveAgainRes = await httpAgent.post(`/api/alerts/${alert.id}/resolve`)

    expect(listRes.body.alerts).to.have.length(1)
    expect(resolveRes.status).to.equal(200)
    expect(resolveRes.body.state).to.equal('resolved')
    expect(resolveAgainRes.status).to.equal(404)
  })

  it('lists notifications', async () => {
    const res = await httpAgent.get('/api/notifications')

    expect(res.status).to.equal(200)
    expect(res.body.notifications).to.deep.equal([])
  })
})
