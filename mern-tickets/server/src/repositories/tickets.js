import Ticket from '../models/ticket.js'

export function create(doc) {
  return Ticket.create(doc)
}

export function findById(id) {
  return Ticket.findById(id)
}

export function find(filter) {
  return Ticket.find(filter).sort({ createdAt: -1 })
}

export function findRecentByReporter(reporterId, since) {
  return Ticket.find({ reporter: reporterId, createdAt: { $gte: since } }).sort({ createdAt: -1 })
}

export function save(ticket) {
  return ticket.save()
}

export function deleteAll() {
  return Ticket.deleteMany({})
}
