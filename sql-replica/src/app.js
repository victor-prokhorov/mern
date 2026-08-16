import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import accounts from './routes/accounts.js'
import documents from './routes/documents.js'
import replication from './routes/replication.js'
import { errorHandler } from './middleware/error.js'

const app = express()

app.use(cors())
app.use(express.json())
app.use('/api/accounts', accounts)
app.use('/api/documents', documents)
app.use('/api/replication', replication)
app.use(errorHandler)

export default app
