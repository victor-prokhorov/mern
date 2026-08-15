import { ObjectId } from 'mongodb'
import * as tickets from '../repositories/tickets.js'
import * as ticketEvents from '../repositories/ticketEvents.js'
import * as comments from '../repositories/comments.js'
import * as users from '../repositories/users.js'
import { BadRequestError, NotFoundError, PreconditionFailedError, PreconditionRequiredError } from '../middleware/error.js'
import { authorize } from '../policy/engine.js'
import { throttle } from '../throttle/tokenBucket.js'
import { run as runHooks } from '../hooks/registry.js'
import { notify } from '../notifier/webhook.js'
import { viewModeratable } from '../moderation/view.js'

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

export async function create({ subject, title, body, priority }) {
  authorize({ subject, action: 'ticket:create', resource: null, context: {} })
  if (!title || !body) throw new BadRequestError('title and body are required')
  if (!SLA_HOURS[priority]) throw new BadRequestError('invalid priority')
  await throttle(subject.id, 'ticket:create')
  const outcome = await runHooks('ticket:before-create', { authorId: subject.id, title, body })
  if (outcome.action === 'reject') throw new BadRequestError(outcome.reason)
  const reporter = await users.findById(subject.id)
  if (!reporter) throw new BadRequestError('invalid reporter')
  const ticket = await tickets.create({
    title: outcome.payload.title,
    body: outcome.payload.body,
    priority,
    status: 'open',
    reporter: reporter._id,
    teamId: reporter.teamId,
    dueAt: dueAtFor(priority),
    moderation: outcome.payload.moderation || { flagged: false, terms: [] }
  })
  await ticketEvents.create({ ticket: ticket._id, actor: reporter._id, type: 'created', from: null, to: 'open' })
  notify({ type: 'ticket:created', ticketId: ticket._id.toString(), status: ticket.status })
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

export async function casWriteOrConflict(ticket, ifMatch, update, subject) {
  if (ifMatch.status === 'missing') throw new PreconditionRequiredError('If-Match header is required')
  if (ifMatch.status === 'malformed') throw new BadRequestError('malformed If-Match header')
  const updated = await tickets.updateIfVersionMatches(ticket._id, ifMatch.version, update)
  if (updated) return updated
  const current = await requireTicket(ticket._id)
  throw new PreconditionFailedError('ticket has been modified since the expected version', current.version, viewModeratable(current, subject))
}

export async function transitionStatus({ subject, id, status, ifMatch }) {
  const ticket = await requireTicket(id)
  authorize({ subject, action: 'ticket:transition', resource: ticket, context: {} })
  const allowed = TRANSITIONS[ticket.status] || []
  if (!allowed.includes(status)) throw new BadRequestError('invalid status transition')
  const from = ticket.status
  const updated = await casWriteOrConflict(ticket, ifMatch, { status }, subject)
  await ticketEvents.create({ ticket: updated._id, actor: subject.id, type: 'status_changed', from, to: status, version: updated.version })
  notify({ type: 'ticket:status-changed', ticketId: updated._id.toString(), status: updated.status })
  return updated
}

export async function assign({ subject, id, assigneeId, ifMatch }) {
  const ticket = await requireTicket(id)
  authorize({ subject, action: 'ticket:assign', resource: ticket, context: {} })
  if (!ObjectId.isValid(assigneeId)) throw new BadRequestError('invalid assignee id')
  const assigneeUser = await users.findById(assigneeId)
  if (!assigneeUser) throw new BadRequestError('assignee not found')
  const from = ticket.assignee ? ticket.assignee.toString() : null
  const updated = await casWriteOrConflict(ticket, ifMatch, { assignee: assigneeUser._id }, subject)
  await ticketEvents.create({ ticket: updated._id, actor: subject.id, type: 'assignee_changed', from, to: assigneeUser._id.toString(), version: updated.version })
  return updated
}

export async function addComment({ subject, id, body }) {
  const ticket = await requireTicket(id)
  authorize({ subject, action: 'ticket:comment', resource: ticket, context: {} })
  if (!body) throw new BadRequestError('body is required')
  await throttle(subject.id, 'comment:create')
  const outcome = await runHooks('comment:before-create', { authorId: subject.id, ticketId: ticket._id, body })
  if (outcome.action === 'reject') throw new BadRequestError(outcome.reason)
  const comment = await comments.create({
    ticket: ticket._id,
    author: subject.id,
    body: outcome.payload.body,
    moderation: outcome.payload.moderation || { flagged: false, terms: [] }
  })
  await ticketEvents.create({ ticket: ticket._id, actor: subject.id, type: 'commented', from: null, to: null })
  return comment
}
