import * as schedulesRepo from '../repositories/schedules.js'
import * as runsRepo from '../repositories/runs.js'
import * as alertRulesRepo from '../repositories/alertRules.js'
import * as lockRepo from '../repositories/lock.js'
import { evaluateRule } from './rules.js'
import { evaluate } from './lifecycle.js'
import { deliverWithRetry } from './delivery.js'

const EVAL_LOCK_KEY = 951414

const DELIVERY_OPTIONS = { maxAttempts: 5, baseMs: 100, capMs: 2000, timeoutMs: 2000 }

async function metricsFor(pool, rule, schedule) {
  if (rule.kind === 'missed_run') {
    const overdueSeconds = await schedulesRepo.overdueSeconds(pool, schedule.id)
    return { overdueSeconds }
  }
  if (rule.kind === 'run_failure_rate') {
    return runsRepo.failureCounts(pool, schedule.id, rule.window_seconds)
  }
  if (rule.kind === 'scheduling_lag') {
    const lagSeconds = await runsRepo.maxLagSeconds(pool, schedule.id, rule.window_seconds)
    return { lagSeconds }
  }
  throw new Error(`unknown alert rule kind: ${rule.kind}`)
}

async function evaluateOne(pool, rule, schedule) {
  const metrics = await metricsFor(pool, rule, schedule)
  const breached = evaluateRule(rule, metrics)
  const outcome = await evaluate(pool, rule, String(schedule.id), breached)
  if (outcome.notification) await deliverWithRetry(pool, outcome.notification, { url: rule.channel, ...DELIVERY_OPTIONS })
  return outcome
}

export async function evaluateAllRules(pool) {
  const rules = await alertRulesRepo.listActive(pool)
  const schedules = await schedulesRepo.list(pool)
  const outcomes = []
  for (const rule of rules) {
    for (const schedule of schedules) {
      try {
        const outcome = await evaluateOne(pool, rule, schedule)
        outcomes.push(outcome)
      } catch (err) {
        outcomes.push({ ruleId: rule.id, scheduleId: schedule.id, error: err.message })
      }
    }
  }
  return outcomes
}

export async function evaluateRulesTick(pool) {
  const client = await pool.connect()
  try {
    const acquired = await lockRepo.tryAcquire(client, EVAL_LOCK_KEY)
    if (!acquired) return { acquired: false, outcomes: [] }
    try {
      const outcomes = await evaluateAllRules(pool)
      return { acquired: true, outcomes }
    } finally {
      await lockRepo.release(client, EVAL_LOCK_KEY)
    }
  } finally {
    client.release()
  }
}
