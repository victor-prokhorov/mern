import 'dotenv/config'
import { pool } from './db.js'
import { migrate } from './migrations/runner.js'
import * as accountsRepo from './repositories/accounts.js'
import * as schedulesRepo from './repositories/schedules.js'
import * as runsRepo from './repositories/runs.js'
import * as alertRulesRepo from './repositories/alertRules.js'
import { nextOccurrence } from './cadence/index.js'

async function seedSchedule({ account, name, cadence, catchupPolicy }) {
  const nextRunAt = nextOccurrence({ cadence, timezone: account.timezone, after: new Date() })
  return schedulesRepo.create(pool, {
    accountId: account.id,
    name,
    cadence,
    timezone: account.timezone,
    nextRunAt,
    catchupPolicy
  })
}

async function seedHistoricalRun(scheduleId, occurrenceAt, lagMs, status, error) {
  const run = await runsRepo.create(pool, { scheduleId, occurrenceAt, status: 'running' })
  await runsRepo.setStartedAtForSeed(pool, run.id, new Date(occurrenceAt.getTime() + lagMs))
  await runsRepo.finish(pool, run.id, { status, error })
}

async function seed() {
  await migrate(pool)

  const parisAccount = await accountsRepo.create(pool, { name: 'Lumen Media (Paris)', timezone: 'Europe/Paris' })
  const nyAccount = await accountsRepo.create(pool, { name: 'Northwind Press (New York)', timezone: 'America/New_York' })
  const tokyoAccount = await accountsRepo.create(pool, { name: 'Sora Studio (Tokyo)', timezone: 'Asia/Tokyo' })

  const intervalSchedule = await seedSchedule({ account: parisAccount, name: 'social-refresh', cadence: 'every 15m', catchupPolicy: 'skip' })
  await seedSchedule({ account: nyAccount, name: 'morning-digest', cadence: 'daily at 08:00', catchupPolicy: 'all' })
  await seedSchedule({ account: tokyoAccount, name: 'weekly-roundup', cadence: 'weekly on mon,thu at 09:00', catchupPolicy: 'none' })
  const failingSchedule = await seedSchedule({ account: parisAccount, name: 'broken-publisher', cadence: 'every 15m', catchupPolicy: 'skip' })

  const now = Date.now()
  for (let i = 10; i >= 1; i--) {
    const occurrenceAt = new Date(now - i * 15 * 60 * 1000)
    await seedHistoricalRun(intervalSchedule.id, occurrenceAt, 3000 + Math.round(Math.random() * 4000), 'success', null)
  }

  for (let i = 8; i >= 1; i--) {
    const occurrenceAt = new Date(now - i * 15 * 60 * 1000)
    const failed = i % 4 !== 0
    await seedHistoricalRun(
      failingSchedule.id,
      occurrenceAt,
      2000,
      failed ? 'failure' : 'success',
      failed ? 'upstream publish endpoint returned 500' : null
    )
  }

  await alertRulesRepo.create(pool, {
    kind: 'run_failure_rate',
    threshold: 0.5,
    windowSeconds: 7200,
    forEvaluations: 1,
    cooldownSeconds: 300,
    channel: 'https://example.com/webhooks/scheduler-alerts'
  })
  await alertRulesRepo.create(pool, {
    kind: 'missed_run',
    threshold: 300,
    windowSeconds: 300,
    forEvaluations: 1,
    cooldownSeconds: 300,
    channel: 'https://example.com/webhooks/scheduler-alerts'
  })
  await alertRulesRepo.create(pool, {
    kind: 'scheduling_lag',
    threshold: 30,
    windowSeconds: 3600,
    forEvaluations: 2,
    cooldownSeconds: 300,
    channel: 'https://example.com/webhooks/scheduler-alerts'
  })

  console.log('seeded 3 accounts, 4 schedules (one per cadence form, plus a deliberately failing one), 18 historical runs, 3 alert rules')
  await pool.end()
}

seed().catch((err) => {
  console.error(err)
  process.exit(1)
})
