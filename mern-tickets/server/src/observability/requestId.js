import { randomUUID } from 'node:crypto'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/

export function sanitizeRequestId(candidate) {
  if (typeof candidate !== 'string') return null
  if (!REQUEST_ID_PATTERN.test(candidate)) return null
  return candidate
}

export function resolveRequestId(inboundHeaderValue) {
  return sanitizeRequestId(inboundHeaderValue) || randomUUID()
}
