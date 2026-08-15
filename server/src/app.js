import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import products from './routes/products.js'

const app = express()

app.use(cors())
app.use(express.json())
app.use('/api/products', products)

export default app
