import mongoose from 'mongoose'

const blockEntrySchema = new mongoose.Schema({
  type: { type: String, required: true, enum: ['email', 'domain'] },
  value: { type: String, required: true },
  reason: { type: String, required: true },
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
})

blockEntrySchema.index({ type: 1, value: 1 })

export default mongoose.model('BlockEntry', blockEntrySchema)
