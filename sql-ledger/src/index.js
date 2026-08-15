import 'dotenv/config'
import app from './app.js'
import { pool } from './db.js'
import { relayOnce, createGuardedPoll } from './outbox/relay.js'

const port = process.env.PORT || 5002
const targetUrl = process.env.OUTBOX_TARGET_URL
const pollMs = Number(process.env.OUTBOX_POLL_MS) || 2000
const batchSize = Number(process.env.OUTBOX_BATCH_SIZE) || 10
const maxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS) || 5

app.listen(port, () => console.log(`listening on ${port}`))

if (targetUrl) {
  const poll = createGuardedPoll(() => relayOnce({ pool, targetUrl, batchSize, maxAttempts }), {
    onError: (err) => console.error('outbox relay failed', err)
  })
  setInterval(poll, pollMs)
}
