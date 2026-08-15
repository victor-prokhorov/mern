import mongoose from 'mongoose'

const ticketEventSchema = new mongoose.Schema({
  ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true, enum: ['created', 'status_changed', 'assignee_changed', 'commented'] },
  from: { type: String, default: null },
  to: { type: String, default: null },
  at: { type: Date, default: Date.now }
})

export default mongoose.model('TicketEvent', ticketEventSchema)
