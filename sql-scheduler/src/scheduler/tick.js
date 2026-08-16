import { withTransaction } from '../db.js'
import * as schedulesRepo from '../repositories/schedules.js'
import * as runsRepo from '../repositories/runs.js'
import * as lockRepo from '../repositories/lock.js'
import { nextOccurrence } from '../cadence/index.js'
import { executeHandler } from './registry.js'

const TICK_LOCK_KEY = 951413

const MAX_BACKLOG = 10000

async function collectBacklog(schedule, now) {
  const occurrences = [schedule.next_run_at]
  let cursor = schedule.next_run_at
  for (let i = 0; i < MAX_BACKLOG; i++) {
    const next = nextOccurrence({ cadence: schedule.cadence, timezone: schedule.timezone, after: cursor })
    if (next.getTime() > now.getTime()) break
    occurrences.push(next)
    cursor = next
  }
  return occurrences
}

async function runOccurrence(client, schedule, occurrenceAt) {
  const run = await runsRepo.createGuarded(client, { scheduleId: schedule.id, occurrenceAt })
  if (!run) return null
  try {
    const result = await executeHandler(schedule, { occurrenceAt })
    const status = result && result.status === 'failure' ? 'failure' : 'success'
    await runsRepo.finish(client, run.id, { status, error: result && result.error ? result.error : null })
  } catch (err) {
    await runsRepo.finish(client, run.id, { status: 'failure', error: err.message })
  }
  return run
}

async function processSchedule(client, schedule, now) {
  const backlog = await collectBacklog(schedule, now)
  const resyncPoint = backlog[backlog.length - 1]
  if (schedule.catchup_policy === 'all') {
    let lastOccurrence = schedule.next_run_at
    for (const occurrenceAt of backlog) {
      await runOccurrence(client, schedule, occurrenceAt)
      lastOccurrence = occurrenceAt
    }
    const nextRunAt = nextOccurrence({ cadence: schedule.cadence, timezone: schedule.timezone, after: lastOccurrence })
    await schedulesRepo.updateAfterRun(client, schedule.id, { nextRunAt, lastRunAt: lastOccurrence })
    return { scheduleId: schedule.id, ran: backlog.length, nextRunAt }
  }
  if (schedule.catchup_policy === 'none') {
    const nextRunAt = nextOccurrence({ cadence: schedule.cadence, timezone: schedule.timezone, after: resyncPoint })
    await schedulesRepo.updateAfterRun(client, schedule.id, { nextRunAt, lastRunAt: schedule.last_run_at })
    return { scheduleId: schedule.id, ran: 0, nextRunAt }
  }
  await runOccurrence(client, schedule, resyncPoint)
  const nextRunAt = nextOccurrence({ cadence: schedule.cadence, timezone: schedule.timezone, after: resyncPoint })
  await schedulesRepo.updateAfterRun(client, schedule.id, { nextRunAt, lastRunAt: resyncPoint })
  return { scheduleId: schedule.id, ran: 1, nextRunAt }
}

async function recordScheduleFailure(pool, schedule, err) {
  try {
    await withTransaction(async (client) => {
      const run = await runsRepo.createGuarded(client, { scheduleId: schedule.id, occurrenceAt: schedule.next_run_at })
      if (run) await runsRepo.finish(client, run.id, { status: 'failure', error: err.message })
    })
  } catch (recordingErr) {
    console.error('failed to record schedule failure', { scheduleId: schedule.id, originalError: err.message, recordingError: recordingErr.message })
  }
}

export async function runDueSchedules(pool, options = {}) {
  const recordFailure = options.recordScheduleFailure || recordScheduleFailure
  const now = await schedulesRepo.currentTime(pool)
  const due = await schedulesRepo.findDue(pool)
  const results = []
  for (const schedule of due) {
    try {
      const result = await withTransaction((client) => processSchedule(client, schedule, now))
      results.push(result)
    } catch (err) {
      try {
        await recordFailure(pool, schedule, err)
      } catch (recordingErr) {
        console.error('schedule failure recording itself failed', { scheduleId: schedule.id, originalError: err.message, recordingError: recordingErr.message })
      }
      results.push({ scheduleId: schedule.id, ran: 0, error: err.message })
    }
  }
  return results
}

export async function tick(pool) {
  const client = await pool.connect()
  try {
    const acquired = await lockRepo.tryAcquire(client, TICK_LOCK_KEY)
    if (!acquired) return { acquired: false, results: [] }
    try {
      const results = await runDueSchedules(pool)
      return { acquired: true, results }
    } finally {
      await lockRepo.release(client, TICK_LOCK_KEY)
    }
  } finally {
    client.release()
  }
}
