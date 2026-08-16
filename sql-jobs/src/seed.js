import 'dotenv/config'
import { pool } from './db.js'
import { migrate } from './migrations/runner.js'
import * as accountsRepo from './repositories/accounts.js'
import * as messagesRepo from './repositories/messages.js'
import * as jobsRepo from './repositories/jobs.js'

const upstreamUrl = process.env.MESSAGE_UPSTREAM_URL || 'http://127.0.0.1:4900/deliver'

async function seedMessage(account, recipient, body) {
  const message = await messagesRepo.create(pool, { accountId: account.id, recipient, body })
  await jobsRepo.enqueue(pool, {
    kind: 'send_message',
    payload: { messageId: message.id, accountId: account.id, recipient, body, upstreamUrl }
  })
  return message
}

async function main() {
  await migrate(pool)
  const acme = await accountsRepo.create(pool, { name: 'Acme Inc' })
  const globex = await accountsRepo.create(pool, { name: 'Globex Corp' })
  const m1 = await seedMessage(acme, 'ada@acme.test', 'Welcome to Acme')
  const m2 = await seedMessage(globex, 'hank@globex.test', 'Welcome to Globex')
  const dead = await jobsRepo.enqueue(pool, { kind: 'always_fails', payload: {}, maxAttempts: 2 })
  console.log('seeded', { accounts: [acme.id, globex.id], messages: [m1.id, m2.id], deliberatelyFailingJob: dead.id })
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
