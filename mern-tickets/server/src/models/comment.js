import mongoose from 'mongoose'

const commentSchema = new mongoose.Schema(
  {
    ticket: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true },
    moderation: {
      flagged: { type: Boolean, default: false },
      terms: { type: [String], default: [] }
    }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

export default mongoose.model('Comment', commentSchema)
