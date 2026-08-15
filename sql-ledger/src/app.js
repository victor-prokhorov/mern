import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import accounts from './routes/accounts.js'
import transfers from './routes/transfers.js'
import { errorHandler } from './middleware/error.js'

const app = express()

app.use(cors())
app.use(express.json())
app.use('/api/accounts', accounts)
app.use('/api/transfers', transfers)
app.use(errorHandler)

export default app
