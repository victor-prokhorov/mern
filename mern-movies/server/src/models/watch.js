import mongoose from 'mongoose'

const watchSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  movie: { type: mongoose.Schema.Types.ObjectId, ref: 'Movie', required: true },
  watchedAt: { type: Date, default: Date.now }
})

watchSchema.index({ user: 1, movie: 1 }, { unique: true })

export default mongoose.model('Watch', watchSchema)
