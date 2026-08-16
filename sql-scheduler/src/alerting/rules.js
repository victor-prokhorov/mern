export const MIN_VOLUME_FOR_FAILURE_RATE = 5

export function evaluateMissedRun(rule, { overdueSeconds }) {
  return overdueSeconds > rule.threshold
}

export function evaluateRunFailureRate(rule, { failures, total }) {
  if (total < MIN_VOLUME_FOR_FAILURE_RATE) return false
  return failures / total > rule.threshold
}

export function evaluateSchedulingLag(rule, { lagSeconds }) {
  return lagSeconds > rule.threshold
}

export function evaluateRule(rule, metrics) {
  if (rule.kind === 'missed_run') return evaluateMissedRun(rule, metrics)
  if (rule.kind === 'run_failure_rate') return evaluateRunFailureRate(rule, metrics)
  if (rule.kind === 'scheduling_lag') return evaluateSchedulingLag(rule, metrics)
  throw new Error(`unknown alert rule kind: ${rule.kind}`)
}
