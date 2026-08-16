import 'dotenv/config'
import app from './app.js'
import { pool } from './db.js'
import { tick } from './scheduler/tick.js'
import { evaluateRulesTick } from './alerting/evaluator.js'

const port = process.env.PORT || 5005
const tickIntervalMs = Number(process.env.TICK_INTERVAL_MS) || 5000
const alertEvalIntervalMs = Number(process.env.ALERT_EVAL_INTERVAL_MS) || 15000

app.listen(port, () => console.log(`listening on ${port}`))

setInterval(() => {
  tick(pool).catch((err) => console.error('tick failed', err))
}, tickIntervalMs)

setInterval(() => {
  evaluateRulesTick(pool).catch((err) => console.error('alert evaluation failed', err))
}, alertEvalIntervalMs)
