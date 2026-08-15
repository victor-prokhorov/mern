import mongoose from 'mongoose'
import { connect } from '../src/db.js'

export function useTestDb() {
  before(async () => {
    await connect(process.env.MONGO_URI)
  })
  beforeEach(async () => {
    await mongoose.connection.dropDatabase()
  })
  after(async () => {
    await mongoose.disconnect()
  })
}
