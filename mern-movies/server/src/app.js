import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import movies from './routes/movies.js'
import actors from './routes/actors.js'
import ratings from './routes/ratings.js'
import watches from './routes/watches.js'
import recommendations from './routes/recommendations.js'
import notifications from './routes/notifications.js'
import { currentUser } from './middleware/currentUser.js'
import { errorHandler } from './middleware/error.js'

const app = express()

app.use(cors())
app.use(express.json())
app.use(currentUser)
app.use('/api/movies', movies)
app.use('/api/actors', actors)
app.use('/api/ratings', ratings)
app.use('/api/watches', watches)
app.use('/api/recommendations', recommendations)
app.use('/api/notifications', notifications)
app.use(errorHandler)

export default app
