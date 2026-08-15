import { ObjectId } from 'mongodb'
import * as users from '../repositories/users.js'
import { UnauthorizedError } from './error.js'
import { setContextField } from '../observability/context.js'

export async function identify(req, res, next) {
  const userId = req.headers['x-user-id']
  if (!userId || !ObjectId.isValid(userId)) throw new UnauthorizedError('x-user-id header is required')
  const user = await users.findById(userId)
  if (!user) throw new UnauthorizedError('unknown user')
  req.subject = { id: user._id.toString(), role: user.role, teamId: user.teamId }
  setContextField('userId', req.subject.id)
  next()
}
