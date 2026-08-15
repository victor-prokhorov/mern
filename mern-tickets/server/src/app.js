import 'express-async-errors'
import express from 'express'
import cors from 'cors'
import auth from './routes/auth.js'
import tickets from './routes/tickets.js'
import { errorHandler } from './middleware/error.js'
import { registerModerationHooks } from './hooks/bootstrap.js'
import { requestContext } from './observability/middleware.js'
import { metricsMiddleware } from './observability/metricsMiddleware.js'
import observabilityRoutes from './observability/routes.js'

registerModerationHooks()

const app = express()

app.use(requestContext)
app.use(metricsMiddleware)
app.use(cors())
app.use(express.json())
app.use(observabilityRoutes)
app.use('/api/auth', auth)
app.use('/api/tickets', tickets)
app.use(errorHandler)

export default app
