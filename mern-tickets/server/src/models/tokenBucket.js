import mongoose from 'mongoose'

const tokenBucketSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  tokens: { type: Number, required: true },
  updatedAt: { type: Date, required: true }
})

export default mongoose.model('TokenBucket', tokenBucketSchema)
