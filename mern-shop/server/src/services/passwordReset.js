import crypto from 'node:crypto'
import bcrypt from 'bcrypt'
import * as passwordResets from '../repositories/passwordResets.js'
import * as users from '../repositories/users.js'
import * as sessions from '../repositories/sessions.js'
import { BadRequestError } from '../middleware/error.js'

const TOKEN_TTL_MS = 15 * 60 * 1000
const MIN_PASSWORD_LENGTH = 15
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
  if (process.env.EXPOSE_RESET_TOKEN === '1') {
    console.log(`password reset token for ${email}: ${rawToken}`)
    return { message: GENERIC_MESSAGE, token: rawToken }
  }
  return { message: GENERIC_MESSAGE }
}

export async function resetPassword(rawToken, password) {
  if (!password || password.length < MIN_PASSWORD_LENGTH) throw new BadRequestError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  const tokenHash = hashToken(rawToken || '')
  const now = new Date()
  const record = await passwordResets.consumeToken(tokenHash, now)
  if (!record) throw new BadRequestError(RESET_TOKEN_INVALID)
  await sessions.revokeAllForUser(record.user, now)
  const passwordHash = await bcrypt.hash(password, 10)
  await users.updatePasswordHash(record.user, passwordHash)
  await passwordResets.invalidateOthersForUser(record.user, record._id)
  return { message: 'password has been reset' }
}
