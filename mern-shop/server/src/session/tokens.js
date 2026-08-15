import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me'

export function signAccessToken({ sub, sid }, { expiresInSeconds = ACCESS_TOKEN_TTL_SECONDS } = {}) {
  return jwt.sign({ sub, sid }, JWT_SECRET, { algorithm: 'HS256', expiresIn: expiresInSeconds })
}

export function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })
}

export function hashRefreshToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function generateRefreshToken() {
  const raw = crypto.randomBytes(32).toString('hex')
  return { raw, hash: hashRefreshToken(raw) }
}
