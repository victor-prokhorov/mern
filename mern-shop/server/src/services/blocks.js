import { ObjectId } from 'mongodb'
import * as blocksRepo from '../repositories/blocks.js'
import * as sessions from '../repositories/sessions.js'
import { BadRequestError, NotFoundError } from '../middleware/error.js'

const GMAIL_DOMAINS = ['gmail.com', 'googlemail.com']

export function normalizeEmail(email) {
  const trimmed = String(email || '').trim().toLowerCase()
  const atIndex = trimmed.lastIndexOf('@')
  if (atIndex === -1) return trimmed
  let local = trimmed.slice(0, atIndex)
  const domain = trimmed.slice(atIndex + 1)
  const plusIndex = local.indexOf('+')
  if (plusIndex !== -1) local = local.slice(0, plusIndex)
  if (GMAIL_DOMAINS.includes(domain)) local = local.replace(/\./g, '')
  return `${local}@${domain}`
}

export function domainOf(email) {
  const normalized = normalizeEmail(email)
  const atIndex = normalized.lastIndexOf('@')
  return atIndex === -1 ? '' : normalized.slice(atIndex + 1)
}

export async function isBlockedEmail(email) {
  if (!email) return false
  const normalized = normalizeEmail(email)
  const domain = domainOf(email)
  const [emailBlock, domainBlock] = await Promise.all([
    blocksRepo.findEntryByTypeAndValue('email', normalized),
    blocksRepo.findEntryByTypeAndValue('domain', domain)
  ])
  return Boolean(emailBlock || domainBlock)
}

export async function createBlock({ type, value, reason, createdBy }) {
  if (type !== 'email' && type !== 'domain') throw new BadRequestError('type must be email or domain')
  if (!value) throw new BadRequestError('value is required')
  if (!reason) throw new BadRequestError('reason is required')
  const normalizedValue = type === 'email' ? normalizeEmail(value) : String(value).trim().toLowerCase()
  return blocksRepo.createEntry({ type, value: normalizedValue, reason, createdBy })
}

export async function removeBlock(id) {
  if (!ObjectId.isValid(id)) throw new BadRequestError('invalid block id')
  const entry = await blocksRepo.findEntryById(id)
  if (!entry) throw new NotFoundError('block entry not found')
  await blocksRepo.deleteEntry(id)
  return entry
}

export async function blockUser(userId, reason) {
  await blocksRepo.blockUser(userId, reason)
  await sessions.revokeAllForUser(userId, new Date())
}

export function unblockUser(userId) {
  return blocksRepo.unblockUser(userId)
}
