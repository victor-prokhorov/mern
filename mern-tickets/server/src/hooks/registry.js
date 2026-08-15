import { logger } from '../observability/logger.js'

const registrations = new Map()

const HANDLER_TIMEOUT_MS = 50

export function register(event, handler) {
  const existing = registrations.get(event) || []
  existing.push(handler)
  registrations.set(event, existing)
}

export function reset(event) {
  if (event) registrations.delete(event)
  else registrations.clear()
}

function withTimeout(work) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handler timed out')), HANDLER_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    Promise.resolve()
      .then(work)
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

export async function run(event, payload) {
  const handlers = registrations.get(event) || []
  let current = payload
  for (const handler of handlers) {
    let result
    try {
      result = await withTimeout(() => handler(current))
    } catch (err) {
      logger.error('hook handler failed', { event, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (!result || result.action === 'continue') continue
    if (result.action === 'reject') return { action: 'reject', reason: result.reason }
    if (result.action === 'transform' && result.payload !== undefined) current = result.payload
  }
  return { action: 'continue', payload: current }
}
