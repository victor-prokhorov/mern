import { ObjectId } from 'mongodb'
import * as tickets from '../repositories/tickets.js'
import * as ticketEvents from '../repositories/ticketEvents.js'
import * as comments from '../repositories/comments.js'
import * as users from '../repositories/users.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

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
  if (!title || !body) throw new BadRequestError('title and body are required')
  if (!SLA_HOURS[priority]) throw new BadRequestError('invalid priority')
  const reporter = await users.findById(subject.id)
  if (!reporter) throw new BadRequestError('invalid reporter')
  const ticket = await tickets.create({
    title,
    body,
    priority,
    status: 'open',
    reporter: reporter._id,
    teamId: reporter.teamId,
    dueAt: dueAtFor(priority)
  })
  await ticketEvents.create({ ticket: ticket._id, actor: reporter._id, type: 'created', from: null, to: 'open' })
  return ticket
}

export function list({ status, assignee, priority }) {
  const filter = {}
  if (status) filter.status = status
  if (assignee) filter.assignee = assignee
  if (priority) filter.priority = priority
  return tickets.find(filter)
}

export async function get(id) {
  const ticket = await requireTicket(id)
  const [ticketComments, events] = await Promise.all([
    comments.findByTicket(ticket._id),
    ticketEvents.findByTicket(ticket._id)
  ])
  return { ticket, comments: ticketComments, events }
}

export async function transitionStatus({ subject, id, status }) {
  const ticket = await requireTicket(id)
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
  if (!body) throw new BadRequestError('body is required')
  const comment = await comments.create({ ticket: ticket._id, author: subject.id, body })
  await ticketEvents.create({ ticket: ticket._id, actor: subject.id, type: 'commented', from: null, to: null })
  return comment
}
