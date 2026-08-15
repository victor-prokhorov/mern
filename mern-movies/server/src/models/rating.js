import mongoose from 'mongoose'

const ratingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  movie: { type: mongoose.Schema.Types.ObjectId, ref: 'Movie', required: true },
  value: { type: Number, required: true, min: 1, max: 10 },
  createdAt: { type: Date, default: Date.now }
})

ratingSchema.index({ user: 1, movie: 1 }, { unique: true })

export default mongoose.model('Rating', ratingSchema)
