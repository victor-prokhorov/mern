import { register } from './registry.js'
import * as blockedTerms from '../repositories/blockedTerms.js'
import * as ticketsRepo from '../repositories/tickets.js'
import * as commentsRepo from '../repositories/comments.js'
import { scan, ALLOWLIST } from '../moderation/keywords.js'

const DUPLICATE_WINDOW_MS = 60 * 1000
const LINK_LIMIT = 3
const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi

async function keywordBlockerHandler(payload) {
  const terms = await blockedTerms.find()
  const matches = scan(`${payload.title || ''} ${payload.body}`, terms, ALLOWLIST)
  if (matches.some((term) => term.severity === 'block')) return { action: 'reject', reason: 'content rejected' }
  if (matches.length === 0) return { action: 'continue' }
  return {
    action: 'transform',
    payload: { ...payload, moderation: { flagged: true, terms: matches.map((term) => term.term) } }
  }
}

function linkLimitHandler(payload) {
  const urls = payload.body.match(URL_PATTERN) || []
  if (urls.length <= LINK_LIMIT) return { action: 'continue' }
  const existingTerms = payload.moderation ? payload.moderation.terms : []
  return {
    action: 'transform',
    payload: { ...payload, moderation: { flagged: true, terms: [...existingTerms, 'link-limit-exceeded'] } }
  }
}

async function duplicateContentHandler(payload) {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS)
  const recent = payload.ticketId
    ? await commentsRepo.findRecentByAuthor(payload.authorId, since)
    : await ticketsRepo.findRecentByReporter(payload.authorId, since)
  const isDuplicate = recent.some((item) => item.body === payload.body)
  if (isDuplicate) return { action: 'reject', reason: 'duplicate submission' }
  return { action: 'continue' }
}

export function registerModerationHooks() {
  register('ticket:before-create', keywordBlockerHandler)
  register('ticket:before-create', linkLimitHandler)
  register('ticket:before-create', duplicateContentHandler)
  register('comment:before-create', keywordBlockerHandler)
  register('comment:before-create', linkLimitHandler)
  register('comment:before-create', duplicateContentHandler)
}
