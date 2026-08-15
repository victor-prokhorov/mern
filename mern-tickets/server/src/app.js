import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import auth from './routes/auth.js'
import tickets from './routes/tickets.js'
import { errorHandler } from './middleware/error.js'

const app = express()

app.use(cors())
app.use(express.json())
app.use('/api/auth', auth)
app.use('/api/tickets', tickets)
app.use(errorHandler)

export default app
