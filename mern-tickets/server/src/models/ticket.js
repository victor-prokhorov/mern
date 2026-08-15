import mongoose from 'mongoose'

const ticketSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    body: { type: String, required: true },
    status: { type: String, required: true, enum: ['open', 'triaged', 'in_progress', 'resolved', 'closed'], default: 'open' },
    priority: { type: String, required: true, enum: ['low', 'normal', 'high', 'urgent'] },
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    teamId: { type: String, required: true },
    dueAt: { type: Date, required: true },
    moderation: {
      flagged: { type: Boolean, default: false },
      terms: { type: [String], default: [] }
    }
  },
  { timestamps: true }
)

export default mongoose.model('Ticket', ticketSchema)
