import mongoose from 'mongoose'

const actorSchema = new mongoose.Schema({
  name: { type: String, required: true }
})

export default mongoose.model('Actor', actorSchema)
