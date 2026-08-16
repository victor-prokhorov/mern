import { withTransaction, pool } from '../db.js'
import * as messagesRepo from '../repositories/messages.js'
import * as accountsRepo from '../repositories/accounts.js'
import * as queue from '../queue/service.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

const DEFAULT_UPSTREAM_URL = process.env.MESSAGE_UPSTREAM_URL || 'http://127.0.0.1:4900/deliver'

export async function createMessage({ accountId, recipient, body, upstreamUrl }) {
  if (!accountId) throw new BadRequestError('accountId is required')
  if (!recipient || typeof recipient !== 'string') throw new BadRequestError('recipient is required')
  if (!body || typeof body !== 'string') throw new BadRequestError('body is required')
  return withTransaction(async (client) => {
    const account = await accountsRepo.findById(client, accountId)
    if (!account) throw new NotFoundError('account not found')
    const message = await messagesRepo.create(client, { accountId, recipient, body })
    await queue.enqueue(client, {
      kind: 'send_message',
      payload: {
        messageId: message.id,
        accountId,
        recipient,
        body,
        upstreamUrl: upstreamUrl || DEFAULT_UPSTREAM_URL
      }
    })
    return message
  })
}

export async function getMessage({ messageId }) {
  const message = await messagesRepo.findById(pool, messageId)
  if (!message) throw new NotFoundError('message not found')
  return message
}

export async function deliverMessage(job) {
  const { messageId, recipient, body, upstreamUrl } = job.payload
  const claimed = await messagesRepo.beginSending(pool, messageId)
  if (!claimed) return false
  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId, recipient, body }),
      signal: AbortSignal.timeout(2000)
    })
    if (!upstreamResponse.ok) throw new Error(`upstream responded ${upstreamResponse.status}`)
    return await messagesRepo.markSent(pool, messageId)
  } catch (err) {
    if (job.attempts + 1 >= job.max_attempts) await messagesRepo.markFailed(pool, messageId)
    throw err
  }
}
