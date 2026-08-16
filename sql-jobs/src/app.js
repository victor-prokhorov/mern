import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import accounts from './routes/accounts.js'
import messages from './routes/messages.js'
import jobs from './routes/jobs.js'
import { errorHandler } from './middleware/error.js'

const app = express()

app.use(cors())
app.use(express.json())
app.use('/api/accounts', accounts)
app.use('/api/messages', messages)
app.use('/api/jobs', jobs)
app.use(errorHandler)

export default app
