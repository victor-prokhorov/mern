const BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

const BREAKER_STATES = ['closed', 'open', 'half-open']

let counters = new Map()
let histograms = new Map()
let breakerStates = new Map()
let breakerTransitions = new Map()

function key(parts) {
  return JSON.stringify(parts)
}

export function statusClassFor(statusCode) {
  return `${Math.floor(statusCode / 100)}xx`
}

export function recordRequest({ method, route, statusCode, durationSeconds }) {
  const statusClass = statusClassFor(statusCode)
  const counterKey = key([method, route, statusClass])
  counters.set(counterKey, (counters.get(counterKey) || 0) + 1)
  const histKey = key([method, route])
  const existing = histograms.get(histKey) || { buckets: BUCKETS_SECONDS.map(() => 0), sum: 0, count: 0 }
  for (let i = 0; i < BUCKETS_SECONDS.length; i++) {
    if (durationSeconds <= BUCKETS_SECONDS[i]) existing.buckets[i] += 1
  }
  existing.sum += durationSeconds
  existing.count += 1
  histograms.set(histKey, existing)
}

export function recordBreakerTransition({ breaker, from, to }) {
  breakerStates.set(breaker, to)
  const transitionKey = key([breaker, from, to])
  breakerTransitions.set(transitionKey, (breakerTransitions.get(transitionKey) || 0) + 1)
}

export function reset() {
  counters = new Map()
  histograms = new Map()
  breakerStates = new Map()
  breakerTransitions = new Map()
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function renderMetrics() {
  const lines = []
  lines.push('# HELP http_requests_total Total number of HTTP requests, labeled by method, route template, and status class.')
  lines.push('# TYPE http_requests_total counter')
  for (const [rawKey, value] of counters) {
    const [method, route, statusClass] = JSON.parse(rawKey)
    lines.push(`http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status_class="${escapeLabel(statusClass)}"} ${value}`)
  }
  lines.push('# HELP http_request_duration_seconds Duration of HTTP requests in seconds, labeled by method and route template.')
  lines.push('# TYPE http_request_duration_seconds histogram')
  for (const [rawKey, hist] of histograms) {
    const [method, route] = JSON.parse(rawKey)
    for (let i = 0; i < BUCKETS_SECONDS.length; i++) {
      lines.push(`http_request_duration_seconds_bucket{method="${escapeLabel(method)}",route="${escapeLabel(route)}",le="${BUCKETS_SECONDS[i]}"} ${hist.buckets[i]}`)
    }
    lines.push(`http_request_duration_seconds_bucket{method="${escapeLabel(method)}",route="${escapeLabel(route)}",le="+Inf"} ${hist.count}`)
    lines.push(`http_request_duration_seconds_sum{method="${escapeLabel(method)}",route="${escapeLabel(route)}"} ${hist.sum}`)
    lines.push(`http_request_duration_seconds_count{method="${escapeLabel(method)}",route="${escapeLabel(route)}"} ${hist.count}`)
  }
  lines.push('# HELP circuit_breaker_state Current circuit breaker state, 1 on the state the breaker is in and 0 on the others.')
  lines.push('# TYPE circuit_breaker_state gauge')
  for (const [breaker, state] of breakerStates) {
    for (const candidate of BREAKER_STATES) {
      lines.push(`circuit_breaker_state{breaker="${escapeLabel(breaker)}",state="${escapeLabel(candidate)}"} ${candidate === state ? 1 : 0}`)
    }
  }
  lines.push('# HELP circuit_breaker_transitions_total Total number of circuit breaker state transitions, labeled by breaker and the states moved between.')
  lines.push('# TYPE circuit_breaker_transitions_total counter')
  for (const [rawKey, value] of breakerTransitions) {
    const [breaker, from, to] = JSON.parse(rawKey)
    lines.push(`circuit_breaker_transitions_total{breaker="${escapeLabel(breaker)}",from="${escapeLabel(from)}",to="${escapeLabel(to)}"} ${value}`)
  }
  return lines.join('\n') + '\n'
}
