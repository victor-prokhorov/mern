import { policies } from './policies.js'
import { ForbiddenError } from '../middleware/error.js'

function ruleMatches(rule, request) {
  const actionMatches = rule.actions.includes('*') || rule.actions.includes(request.action)
  const roleMatches = !rule.roles || rule.roles.includes(request.subject.role)
  const conditionMatches = !rule.condition || rule.condition(request)
  return actionMatches && roleMatches && conditionMatches
}

export function decide(ruleSet, request) {
  const matches = ruleSet.filter((rule) => ruleMatches(rule, request))
  const denyMatch = matches.find((rule) => rule.effect === 'deny')
  if (denyMatch) return { effect: 'deny', reason: denyMatch.reason, ruleId: denyMatch.id }
  const permitMatch = matches.find((rule) => rule.effect === 'permit')
  if (permitMatch) return { effect: 'permit', reason: permitMatch.reason, ruleId: permitMatch.id }
  return { effect: 'deny', reason: 'default deny: no rule matched the request', ruleId: null }
}

export function authorize(request) {
  const decision = decide(policies, request)
  if (decision.effect === 'deny') {
    console.error(`authz denied action=${request.action} ruleId=${decision.ruleId} reason=${decision.reason}`)
    throw new ForbiddenError('forbidden')
  }
  return decision
}
