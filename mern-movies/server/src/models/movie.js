import mongoose from 'mongoose'

const movieSchema = new mongoose.Schema({
  title: { type: String, required: true },
  genres: { type: [String], default: [] },
  cast: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Actor' }],
  averageRating: { type: Number, required: true, min: 0, max: 10 },
  releasedAt: { type: Date, required: true }
})

movieSchema.index({ genres: 1 })
movieSchema.index({ averageRating: 1 })

export default mongoose.model('Movie', movieSchema)
