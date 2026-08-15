import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import products from './routes/products.js'
import auth from './routes/auth.js'
import cart from './routes/cart.js'
import orders from './routes/orders.js'
import blocks from './routes/blocks.js'
import { errorHandler } from './middleware/error.js'
import { rateLimit } from './middleware/rateLimit.js'

const app = express()

const loginIpLimit = rateLimit({ limit: 5, windowMs: 60 * 1000, keyBy: (req) => `login:ip:${req.ip}` })
const loginEmailLimit = rateLimit({ limit: 5, windowMs: 60 * 1000, keyBy: (req) => `login:email:${String(req.body.email || '').toLowerCase()}` })
const forgotPasswordEmailLimit = rateLimit({ limit: 3, windowMs: 60 * 60 * 1000, keyBy: (req) => `forgot-password:email:${String(req.body.email || '').toLowerCase()}` })
const resetPasswordIpLimit = rateLimit({ limit: 10, windowMs: 60 * 60 * 1000, keyBy: (req) => `reset-password:ip:${req.ip}` })
const refreshIpLimit = rateLimit({ limit: 20, windowMs: 60 * 60 * 1000, keyBy: (req) => `refresh:ip:${req.ip}` })

app.use(cors())
app.use(express.json())
app.use('/api/products', products)
app.use('/api/auth/login', loginIpLimit, loginEmailLimit)
app.use('/api/auth/forgot-password', forgotPasswordEmailLimit)
app.use('/api/auth/reset-password', resetPasswordIpLimit)
app.use(['/api/auth/refresh', '/api/auth/logout'], refreshIpLimit)
app.use('/api/auth', auth)
app.use('/api/cart', cart)
app.use('/api/orders', orders)
app.use('/api/blocks', blocks)
app.use(errorHandler)

export default app
