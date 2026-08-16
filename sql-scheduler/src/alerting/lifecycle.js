import { withTransaction } from '../db.js'
import * as alertsRepo from '../repositories/alerts.js'
import * as notificationsRepo from '../repositories/notifications.js'

function buildPayload(rule, alert, subject) {
  return { ruleId: rule.id, kind: rule.kind, subject, state: alert.state, occurrences: alert.occurrences }
}

async function persist(client, rule, subject, alertId, fields, shouldNotify, now) {
  const saved = await alertsRepo.updateProgress(client, alertId, {
    ...fields,
    lastNotifiedAt: shouldNotify ? now : null
  })
  if (!shouldNotify) return { alert: saved, notification: null }
  const notification = await notificationsRepo.create(client, {
    alertId: saved.id,
    channel: rule.channel,
    payload: buildPayload(rule, saved, subject)
  })
  return { alert: saved, notification }
}

async function onBreach(client, rule, subject, existing, now) {
  const consecutiveBreaches = existing.consecutive_breaches + 1
  const occurrences = existing.occurrences + 1
  if (existing.state === 'pending') {
    const crossesThreshold = consecutiveBreaches >= rule.for_evaluations
    return persist(
      client,
      rule,
      subject,
      existing.id,
      { state: crossesThreshold ? 'firing' : 'pending', consecutiveBreaches, consecutiveClears: 0, occurrences, resolvedAt: null },
      crossesThreshold,
      now
    )
  }
  const cooldownElapsed = !existing.last_notified_at || now.getTime() - new Date(existing.last_notified_at).getTime() >= rule.cooldown_seconds * 1000
  return persist(
    client,
    rule,
    subject,
    existing.id,
    { state: 'firing', consecutiveBreaches, consecutiveClears: 0, occurrences, resolvedAt: null },
    cooldownElapsed,
    now
  )
}

async function onClear(client, rule, subject, existing, now) {
  if (existing.state === 'pending') {
    await alertsRepo.remove(client, existing.id)
    return { alert: null, notification: null }
  }
  const consecutiveClears = existing.consecutive_clears + 1
  const resolves = consecutiveClears >= rule.for_evaluations
  return persist(
    client,
    rule,
    subject,
    existing.id,
    {
      state: resolves ? 'resolved' : 'firing',
      consecutiveBreaches: 0,
      consecutiveClears,
      occurrences: existing.occurrences,
      resolvedAt: resolves ? now : null
    },
    resolves,
    now
  )
}

export async function evaluate(pool, rule, subject, breached, { now = new Date() } = {}) {
  return withTransaction(async (client) => {
    const existing = await alertsRepo.findOpen(client, rule.id, subject)
    if (!existing) {
      if (!breached) return { alert: null, notification: null }
      const startsFiring = rule.for_evaluations <= 1
      const created = await alertsRepo.create(client, {
        ruleId: rule.id,
        subject,
        state: startsFiring ? 'firing' : 'pending',
        consecutiveBreaches: 1,
        consecutiveClears: 0,
        occurrences: 1
      })
      if (!startsFiring) return { alert: created, notification: null }
      const notification = await notificationsRepo.create(client, {
        alertId: created.id,
        channel: rule.channel,
        payload: buildPayload(rule, created, subject)
      })
      await alertsRepo.updateProgress(client, created.id, {
        state: created.state,
        consecutiveBreaches: created.consecutive_breaches,
        consecutiveClears: created.consecutive_clears,
        occurrences: created.occurrences,
        lastNotifiedAt: now,
        resolvedAt: null
      })
      return { alert: created, notification }
    }
    if (breached) return onBreach(client, rule, subject, existing, now)
    return onClear(client, rule, subject, existing, now)
  })
}
