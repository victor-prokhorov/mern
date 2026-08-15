import { ObjectId } from 'mongodb'
import * as tickets from '../repositories/tickets.js'
import * as ticketEvents from '../repositories/ticketEvents.js'
import * as comments from '../repositories/comments.js'
import * as users from '../repositories/users.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'
import { authorize } from '../policy/engine.js'
import * as blockedTerms from '../repositories/blockedTerms.js'
import { scan, ALLOWLIST } from '../moderation/keywords.js'

export const TRANSITIONS = {
  open: ['triaged'],
  triaged: ['in_progress'],
  in_progress: ['resolved'],
  resolved: ['closed', 'open'],
  closed: []
}

const SLA_HOURS = { urgent: 4, high: 24, normal: 72, low: 168 }

function dueAtFor(priority) {
  const hours = SLA_HOURS[priority]
  return new Date(Date.now() + hours * 60 * 60 * 1000)
}

async function requireTicket(id) {
  if (!ObjectId.isValid(id)) throw new BadRequestError('invalid ticket id')
  const ticket = await tickets.findById(id)
  if (!ticket) throw new NotFoundError('ticket not found')
  return ticket
}

async function moderate(text) {
  const terms = await blockedTerms.find()
  const matches = scan(text, terms, ALLOWLIST)
  if (matches.some((term) => term.severity === 'block')) throw new BadRequestError('content rejected')
  return matches.map((term) => term.term)
}

export async function create({ subject, title, body, priority }) {
  authorize({ subject, action: 'ticket:create', resource: null, context: {} })
  if (!title || !body) throw new BadRequestError('title and body are required')
  if (!SLA_HOURS[priority]) throw new BadRequestError('invalid priority')
  const matchedTerms = await moderate(`${title} ${body}`)
  const reporter = await users.findById(subject.id)
  if (!reporter) throw new BadRequestError('invalid reporter')
  const ticket = await tickets.create({
    title,
    body,
    priority,
    status: 'open',
    reporter: reporter._id,
    teamId: reporter.teamId,
    dueAt: dueAtFor(priority),
    moderation: { flagged: matchedTerms.length > 0, terms: matchedTerms }
  })
  await ticketEvents.create({ ticket: ticket._id, actor: reporter._id, type: 'created', from: null, to: 'open' })
  return ticket
}

export function list({ subject, status, assignee, priority }) {
  const filter = {}
  if (status) filter.status = status
  if (assignee) filter.assignee = assignee
  if (priority) filter.priority = priority
  if (subject.role === 'reporter') filter.reporter = subject.id
  else if (subject.role === 'agent') filter.teamId = subject.teamId
  return tickets.find(filter)
}

export async function get({ subject, id }) {
  const ticket = await requireTicket(id)
  authorize({ subject, action: 'ticket:read', resource: ticket, context: {} })
  const [ticketComments, events] = await Promise.all([
    comments.findByTicket(ticket._id),
    ticketEvents.findByTicket(ticket._id)
  ])
  return { ticket, comments: ticketComments, events }
}

export async function transitionStatus({ subject, id, status }) {
  const ticket = await requireTicket(id)
  authorize({ subject, action: 'ticket:transition', resource: ticket, context: {} })
  const allowed = TRANSITIONS[ticket.status] || []
  if (!allowed.includes(status)) throw new BadRequestError('invalid status transition')
  const from = ticket.status
  ticket.status = status
  await tickets.save(ticket)
  await ticketEvents.create({ ticket: ticket._id, actor: subject.id, type: 'status_changed', from, to: status })
  return ticket
}

export async function assign({ subject, id, assigneeId }) {
  const ticket = await requireTicket(id)
  authorize({ subject, action: 'ticket:assign', resource: ticket, context: {} })
  if (!ObjectId.isValid(assigneeId)) throw new BadRequestError('invalid assignee id')
  const assigneeUser = await users.findById(assigneeId)
  if (!assigneeUser) throw new BadRequestError('assignee not found')
  const from = ticket.assignee ? ticket.assignee.toString() : null
  ticket.assignee = assigneeUser._id
  await tickets.save(ticket)
  await ticketEvents.create({ ticket: ticket._id, actor: subject.id, type: 'assignee_changed', from, to: assigneeUser._id.toString() })
  return ticket
}

export async function addComment({ subject, id, body }) {
  const ticket = await requireTicket(id)
  authorize({ subject, action: 'ticket:comment', resource: ticket, context: {} })
  if (!body) throw new BadRequestError('body is required')
  const matchedTerms = await moderate(body)
  const comment = await comments.create({ ticket: ticket._id, author: subject.id, body, moderation: { flagged: matchedTerms.length > 0, terms: matchedTerms } })
  await ticketEvents.create({ ticket: ticket._id, actor: subject.id, type: 'commented', from: null, to: null })
  return comment
}
