import mongoose from 'mongoose'

const sessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  familyId: { type: String, required: true },
  tokenHash: { type: String, required: true },
  issuedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  replacedBy: { type: String, default: null }
})

sessionSchema.index({ tokenHash: 1 }, { unique: true })
sessionSchema.index({ familyId: 1 })
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model('Session', sessionSchema)
