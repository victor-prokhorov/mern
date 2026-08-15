import { verifyAccessToken } from '../session/tokens.js'
import { UnauthorizedError } from './error.js'

export function requireAuth(req, res, next) {
  const header = req.get('Authorization') || ''
  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token) throw new UnauthorizedError('authentication required')
  let payload
  try {
    payload = verifyAccessToken(token)
  } catch (err) {
    throw new UnauthorizedError('invalid or expired access token')
  }
  req.userId = payload.sub
  req.sessionId = payload.sid
  next()
}
