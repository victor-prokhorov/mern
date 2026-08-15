import mongoose from 'mongoose'

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' }
})

userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.passwordHash
    delete ret.__v
    return ret
  }
})

export default mongoose.model('User', userSchema)
