import 'dotenv/config'
import app from './app.js'
import { pool } from './db.js'
import { registerHandler } from './queue/handlers.js'
import { createWorker } from './queue/worker.js'
import { reapExpired } from './queue/service.js'
import { deliverMessage } from './services/messages.js'

const port = process.env.PORT || 5004
const pollMs = Number(process.env.WORKER_POLL_MS) || 500
const concurrency = Number(process.env.WORKER_CONCURRENCY) || 4
const leaseMs = Number(process.env.WORKER_LEASE_MS) || 10000

registerHandler('send_message', deliverMessage)

app.listen(port, () => console.log(`listening on ${port}`))

const worker = createWorker({
  pool,
  workerId: `worker-${process.pid}`,
  concurrency,
  pollMs,
  leaseMs,
  onError: (err, job) => console.error('job failed', job && job.id, err)
})
worker.start()

setInterval(() => {
  reapExpired(pool).catch((err) => console.error('reap failed', err))
}, leaseMs)

process.on('SIGTERM', async () => {
  await worker.stop({ timeoutMs: 5000 })
  process.exit(0)
})
