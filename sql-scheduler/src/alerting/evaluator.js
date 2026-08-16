import * as schedulesRepo from '../repositories/schedules.js'
import * as runsRepo from '../repositories/runs.js'
import * as alertRulesRepo from '../repositories/alertRules.js'
import { evaluateRule } from './rules.js'
import { evaluate } from './lifecycle.js'

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

export async function evaluateAllRules(pool) {
  const rules = await alertRulesRepo.listActive(pool)
  const schedules = await schedulesRepo.list(pool)
  const outcomes = []
  for (const rule of rules) {
    for (const schedule of schedules) {
      const metrics = await metricsFor(pool, rule, schedule)
      const breached = evaluateRule(rule, metrics)
      const outcome = await evaluate(pool, rule, String(schedule.id), breached)
      outcomes.push(outcome)
    }
  }
  return outcomes
}
