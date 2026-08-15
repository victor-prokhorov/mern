import jwt from 'jsonwebtoken'
import { UnauthorizedError } from './error.js'

export function requireAuth(req, res, next) {
  const header = req.get('Authorization') || ''
  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token) throw new UnauthorizedError('authentication required')
  const payload = jwt.decode(token)
  if (!payload) throw new UnauthorizedError('invalid or expired access token')
  req.userId = payload.sub
  req.sessionId = payload.sid
  next()
}
