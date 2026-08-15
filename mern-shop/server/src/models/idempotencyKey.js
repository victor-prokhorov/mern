import mongoose from 'mongoose'

const idempotencyKeySchema = new mongoose.Schema({
  key: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requestFingerprint: { type: String, required: true },
  status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
  response: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now },
  claimedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true, expires: 0 }
})

idempotencyKeySchema.index({ key: 1, user: 1 }, { unique: true })

export default mongoose.model('IdempotencyKey', idempotencyKeySchema)
