import mongoose from 'mongoose'

const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['actor_in_new_movie'], required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'Actor', required: true },
  movie: { type: mongoose.Schema.Types.ObjectId, ref: 'Movie', required: true },
  readAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
})

notificationSchema.index({ user: 1, movie: 1, actor: 1 }, { unique: true })

export default mongoose.model('Notification', notificationSchema)
