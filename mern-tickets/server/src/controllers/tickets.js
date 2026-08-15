import * as tickets from '../services/tickets.js'

export async function create(req, res) {
  const ticket = await tickets.create({ subject: req.subject, title: req.body.title, body: req.body.body, priority: req.body.priority })
  res.status(201).json(ticket)
}

export async function list(req, res) {
  res.json(await tickets.list({ status: req.query.status, assignee: req.query.assignee, priority: req.query.priority }))
}

export async function get(req, res) {
  res.json(await tickets.get(req.params.id))
}

export async function updateStatus(req, res) {
  res.json(await tickets.transitionStatus({ subject: req.subject, id: req.params.id, status: req.body.status }))
}

export async function updateAssignee(req, res) {
  res.json(await tickets.assign({ subject: req.subject, id: req.params.id, assigneeId: req.body.assigneeId }))
}

export async function addComment(req, res) {
  res.status(201).json(await tickets.addComment({ subject: req.subject, id: req.params.id, body: req.body.body }))
}
