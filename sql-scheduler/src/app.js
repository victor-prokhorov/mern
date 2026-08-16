import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import accounts from './routes/accounts.js'
import schedules from './routes/schedules.js'
import runs from './routes/runs.js'
import alerts from './routes/alerts.js'
import notifications from './routes/notifications.js'
import { errorHandler } from './middleware/error.js'

const app = express()

app.use(cors())
app.use(express.json())
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }))
app.use('/api/accounts', accounts)
app.use('/api/schedules', schedules)
app.use('/api/runs', runs)
app.use('/api/alerts', alerts)
app.use('/api/notifications', notifications)
app.use(errorHandler)

export default app
