import * as tickets from '../services/tickets.js'
import { formatETag, readIfMatch } from '../concurrency/etag.js'

function canSeeModerationDetail(subject) {
  return subject.role === 'agent' || subject.role === 'admin'
}

function viewModeratable(doc, subject) {
  const json = doc.toJSON()
  if (canSeeModerationDetail(subject)) return json
  return { ...json, moderation: { flagged: json.moderation.flagged } }
}

export async function create(req, res) {
  const ticket = await tickets.create({ subject: req.subject, title: req.body.title, body: req.body.body, priority: req.body.priority })
  res.set('ETag', formatETag(ticket.version))
  res.status(201).json(viewModeratable(ticket, req.subject))
}

export async function list(req, res) {
  const found = await tickets.list({ subject: req.subject, status: req.query.status, assignee: req.query.assignee, priority: req.query.priority })
  res.json(found.map((ticket) => viewModeratable(ticket, req.subject)))
}

export async function get(req, res) {
  const result = await tickets.get({ subject: req.subject, id: req.params.id })
  res.set('ETag', formatETag(result.ticket.version))
  res.json({
    ticket: viewModeratable(result.ticket, req.subject),
    comments: result.comments.map((comment) => viewModeratable(comment, req.subject)),
    events: result.events
  })
}

export async function updateStatus(req, res) {
  const ticket = await tickets.transitionStatus({ subject: req.subject, id: req.params.id, status: req.body.status, ifMatch: readIfMatch(req.headers['if-match']) })
  res.set('ETag', formatETag(ticket.version))
  res.json(viewModeratable(ticket, req.subject))
}

export async function updateAssignee(req, res) {
  const ticket = await tickets.assign({ subject: req.subject, id: req.params.id, assigneeId: req.body.assigneeId, ifMatch: readIfMatch(req.headers['if-match']) })
  res.set('ETag', formatETag(ticket.version))
  res.json(viewModeratable(ticket, req.subject))
}

export async function addComment(req, res) {
  const comment = await tickets.addComment({ subject: req.subject, id: req.params.id, body: req.body.body })
  res.status(201).json(viewModeratable(comment, req.subject))
}
