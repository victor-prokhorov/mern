import mongoose from 'mongoose'
import { normalize } from '../moderation/normalize.js'
import { MIN_SUBSTRING_TERM_LENGTH } from '../moderation/keywords.js'

const blockedTermSchema = new mongoose.Schema(
  {
    term: { type: String, required: true },
    severity: { type: String, required: true, enum: ['block', 'flag'] },
    matchType: { type: String, required: true, enum: ['word', 'substring'] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
)

blockedTermSchema.pre('validate', function assertTermIsMatchable() {
  const normalized = normalize(this.term || '')
  if (!/[^a-z0-9]/.test(normalized)) return
  this.invalidate(
    'term',
    `terms must normalize to a single alphanumeric token or they can never match, and "${this.term}" normalizes to "${normalized}"`
  )
})

blockedTermSchema.pre('validate', function assertSubstringTermIsLongEnough() {
  if (this.matchType !== 'substring') return
  const normalized = normalize(this.term || '')
  if (normalized.length >= MIN_SUBSTRING_TERM_LENGTH) return
  this.invalidate(
    'term',
    `substring terms must be at least ${MIN_SUBSTRING_TERM_LENGTH} characters after normalization, and "${this.term}" normalizes to "${normalized}"`
  )
})

export default mongoose.model('BlockedTerm', blockedTermSchema)
