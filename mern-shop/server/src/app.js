import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import products from './routes/products.js'
import auth from './routes/auth.js'
import cart from './routes/cart.js'
import orders from './routes/orders.js'
import { errorHandler } from './middleware/error.js'

const app = express()

app.use(cors())
app.use(express.json())
app.use('/api/products', products)
app.use('/api/auth', auth)
app.use('/api/cart', cart)
app.use('/api/orders', orders)
app.use(errorHandler)

export default app
