import mongoose from 'mongoose'

export const IDLE_BUCKET_TTL_SECONDS = 24 * 60 * 60

const tokenBucketSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  tokens: { type: Number, required: true },
  updatedAt: { type: Date, required: true }
})

tokenBucketSchema.index({ updatedAt: 1 }, { expireAfterSeconds: IDLE_BUCKET_TTL_SECONDS })

export default mongoose.model('TokenBucket', tokenBucketSchema)
