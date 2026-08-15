import mongoose from 'mongoose'

export function connect(uri) {
  return mongoose.connect(uri)
}
