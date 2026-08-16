import mongoose from 'mongoose'

const followSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'Actor', required: true },
  createdAt: { type: Date, default: Date.now }
})

followSchema.index({ user: 1, actor: 1 }, { unique: true })
followSchema.index({ actor: 1 })

export default mongoose.model('Follow', followSchema)
