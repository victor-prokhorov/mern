import crypto from 'node:crypto'
import bcrypt from 'bcrypt'
import * as passwordResets from '../repositories/passwordResets.js'
import * as users from '../repositories/users.js'
import { BadRequestError } from '../middleware/error.js'

const TOKEN_TTL_MS = 15 * 60 * 1000
const RESET_TOKEN_INVALID = 'reset token is invalid or expired'
const GENERIC_MESSAGE = 'if that email exists, a password reset link has been sent'

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

export async function forgotPassword(email) {
  const user = email ? await users.findByEmail(email) : null
  if (!user) return { message: GENERIC_MESSAGE }
  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)
  await passwordResets.create({ user: user._id, tokenHash, expiresAt })
  console.log(`password reset token for ${email}: ${rawToken}`)
  if (process.env.NODE_ENV !== 'production') return { message: GENERIC_MESSAGE, token: rawToken }
  return { message: GENERIC_MESSAGE }
}

export async function resetPassword(rawToken, password) {
  if (!password || password.length < 8) throw new BadRequestError('password must be at least 8 characters')
  const tokenHash = hashToken(rawToken || '')
  const record = await passwordResets.findByTokenHash(tokenHash)
  const isInvalid = !record || record.usedAt !== null || record.expiresAt.getTime() < Date.now()
  if (isInvalid) throw new BadRequestError(RESET_TOKEN_INVALID)
  const passwordHash = await bcrypt.hash(password, 10)
  await users.updatePasswordHash(record.user, passwordHash)
  await passwordResets.markUsed(record._id)
  await passwordResets.invalidateOthersForUser(record.user, record._id)
  return { message: 'password has been reset' }
}
