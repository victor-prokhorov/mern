import mongoose from 'mongoose'

const blockedTermSchema = new mongoose.Schema(
  {
    term: { type: String, required: true },
    severity: { type: String, required: true, enum: ['block', 'flag'] },
    matchType: { type: String, required: true, enum: ['word', 'substring'] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
)

export default mongoose.model('BlockedTerm', blockedTermSchema)
