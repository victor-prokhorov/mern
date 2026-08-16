import 'dotenv/config'
import mongoose from 'mongoose'
import app from './app.js'
import { connect } from './db.js'

const port = process.env.PORT || 5006
const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-cache'

await connect(uri)
const server = app.listen(port, () => console.log(`listening on ${port}`))

function shutdown() {
  server.close(() => mongoose.disconnect().then(() => process.exit(0)))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
