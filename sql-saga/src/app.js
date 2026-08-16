import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import inventory from './routes/inventory.js'
import orders from './routes/orders.js'
import sagas from './routes/sagas.js'
import { errorHandler } from './middleware/error.js'

const app = express()

app.use(cors())
app.use(express.json())
app.use('/api/inventory', inventory)
app.use('/api/orders', orders)
app.use('/api/sagas', sagas)
app.use(errorHandler)

export default app
