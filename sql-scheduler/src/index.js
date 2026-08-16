import 'dotenv/config'
import app from './app.js'
import { pool } from './db.js'
import { tick } from './scheduler/tick.js'

const port = process.env.PORT || 5005
const tickIntervalMs = Number(process.env.TICK_INTERVAL_MS) || 5000

app.listen(port, () => console.log(`listening on ${port}`))

setInterval(() => {
  tick(pool).catch((err) => console.error('tick failed', err))
}, tickIntervalMs)
