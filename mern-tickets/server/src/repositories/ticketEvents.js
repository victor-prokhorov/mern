import TicketEvent from '../models/ticketEvent.js'

export function create(doc) {
  return TicketEvent.create(doc)
}

export function findByTicket(ticketId) {
  return TicketEvent.find({ ticket: ticketId }).sort({ at: 1 })
}

export function deleteAll() {
  return TicketEvent.deleteMany({})
}
