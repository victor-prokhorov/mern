import { BadRequestError } from '../middleware/error.js'

export function encodeCursor({ createdAt, id }) {
  const payload = JSON.stringify({ c: createdAt, i: String(id) })
  return Buffer.from(payload, 'utf8').toString('base64url')
}

export function decodeCursor(raw) {
  let payload
  try {
    payload = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))
  } catch (err) {
    throw new BadRequestError('malformed cursor')
  }
  if (!payload || typeof payload.c !== 'string' || typeof payload.i !== 'string' || !/^\d+$/.test(payload.i)) {
    throw new BadRequestError('malformed cursor')
  }
  const createdAt = new Date(payload.c)
  if (Number.isNaN(createdAt.getTime())) throw new BadRequestError('malformed cursor')
  return { createdAt, id: payload.i }
}
