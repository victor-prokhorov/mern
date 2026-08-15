import mongoose from 'mongoose'

const rateLimitSchema = new mongoose.Schema({
  key: { type: String, required: true },
  windowStart: { type: Number, required: true },
  count: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true, expires: 0 }
})

rateLimitSchema.index({ key: 1, windowStart: 1 }, { unique: true })

export default mongoose.model('RateLimit', rateLimitSchema)
