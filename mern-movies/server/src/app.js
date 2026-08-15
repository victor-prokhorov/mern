import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import { currentUser } from './middleware/currentUser.js'
import { errorHandler } from './middleware/error.js'

const app = express()

app.use(cors())
app.use(express.json())
app.use(currentUser)
app.use(errorHandler)

export default app
