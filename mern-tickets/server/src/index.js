import 'dotenv/config'
import mongoose from 'mongoose'
import app from './app.js'
import { connect } from './db.js'
import { createGracefulShutdown } from './observability/shutdown.js'
import { setReady } from './observability/health.js'

const port = process.env.PORT || 5001
const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-tickets'

await connect(uri)
const server = app.listen(port, () => console.log(`listening on ${port}`))

const shutdown = createGracefulShutdown({
  server,
  closeStore: () => mongoose.disconnect(),
  setNotReady: () => setReady(false)
})

process.on('SIGTERM', shutdown)
