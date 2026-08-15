import bcrypt from 'bcrypt'
import * as users from '../repositories/users.js'
import * as sessions from '../repositories/sessions.js'
import * as blocks from './blocks.js'
import { hashRefreshToken } from '../session/tokens.js'
import { BadRequestError, UnauthorizedError } from '../middleware/error.js'

export async function login(email, password) {
  if (!email || !password) throw new BadRequestError('email and password are required')
  const user = await users.findByEmail(email)
  const matches = user ? await bcrypt.compare(password, user.passwordHash) : false
  if (!matches) throw new UnauthorizedError('invalid credentials')
  if (user.blockedAt || (await blocks.isBlockedEmail(user.email))) throw new UnauthorizedError('invalid credentials')
  return user
}

export async function refresh(rawRefreshToken) {
  if (!rawRefreshToken) throw new BadRequestError('refresh token is required')
  const tokenHash = hashRefreshToken(rawRefreshToken)
  const existing = await sessions.findByTokenHash(tokenHash)
  if (!existing) throw new UnauthorizedError('invalid refresh token')
  return { accessToken: 'stub-access-token', refreshToken: rawRefreshToken }
}

export async function logout(rawRefreshToken) {
  return { message: 'logged out' }
}
