import bcrypt from 'bcrypt'
import crypto from 'node:crypto'
import * as users from '../repositories/users.js'
import * as sessions from '../repositories/sessions.js'
import * as blocks from './blocks.js'
import { signAccessToken, generateRefreshToken, hashRefreshToken, REFRESH_TOKEN_TTL_MS } from '../session/tokens.js'
import { BadRequestError, UnauthorizedError } from '../middleware/error.js'

const UNKNOWN_EMAIL_DUMMY_HASH = '$2b$10$D9.gDa/R3XimjbfbNaZr1eySVokSRNJVe936JPeC2ZKmWDrdZwApC'

async function issueSession(userId, familyId) {
  const now = new Date()
  const { raw, hash } = generateRefreshToken()
  await sessions.create({ user: userId, familyId, tokenHash: hash, issuedAt: now, expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS) })
  const accessToken = signAccessToken({ sub: userId.toString(), sid: familyId })
  return { accessToken, refreshToken: raw, tokenHash: hash }
}

export async function login(email, password) {
  if (!email || !password) throw new BadRequestError('email and password are required')
  const user = await users.findByEmail(email)
  const matches = await bcrypt.compare(password, user ? user.passwordHash : UNKNOWN_EMAIL_DUMMY_HASH)
  if (!user || !matches) throw new UnauthorizedError('invalid credentials')
  if (user.blockedAt || (await blocks.isBlockedEmail(user.email))) throw new UnauthorizedError('invalid credentials')
  const familyId = crypto.randomUUID()
  const { accessToken, refreshToken } = await issueSession(user._id, familyId)
  return { user, accessToken, refreshToken }
}

export async function completeRotation(consumed, now) {
  const { accessToken, refreshToken, tokenHash: newTokenHash } = await issueSession(consumed.user, consumed.familyId)
  await sessions.markReplacedBy(consumed._id, newTokenHash)
  if (await sessions.isFamilyRevoked(consumed.familyId)) {
    await sessions.revokeFamily(consumed.familyId, now)
    throw new UnauthorizedError('invalid refresh token')
  }
  return { accessToken, refreshToken }
}

export async function refresh(rawRefreshToken) {
  if (!rawRefreshToken) throw new BadRequestError('refresh token is required')
  const tokenHash = hashRefreshToken(rawRefreshToken)
  const now = new Date()
  const consumed = await sessions.consumeToken(tokenHash, now)
  if (consumed) {
    const user = await users.findById(consumed.user)
    if (!user || user.blockedAt || (await blocks.isBlockedEmail(user.email))) {
      await sessions.revokeFamily(consumed.familyId, now)
      throw new UnauthorizedError('invalid refresh token')
    }
    return completeRotation(consumed, now)
  }
  const existing = await sessions.findByTokenHash(tokenHash)
  if (existing && existing.usedAt && !existing.revokedAt) await sessions.revokeFamily(existing.familyId, now)
  throw new UnauthorizedError('invalid refresh token')
}

export async function logout(rawRefreshToken) {
  if (!rawRefreshToken) throw new BadRequestError('refresh token is required')
  const tokenHash = hashRefreshToken(rawRefreshToken)
  const existing = await sessions.findByTokenHash(tokenHash)
  if (existing) await sessions.revokeFamily(existing.familyId, new Date())
  return { message: 'logged out' }
}
