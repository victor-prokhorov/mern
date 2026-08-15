import { expect } from 'chai'
import BlockedTerm from '../src/models/blockedTerm.js'
import { seedUsers, seedBlockedTerms, blockedTermSpecs } from '../src/seed.js'
import { useTestDb } from './helpers.js'

describe('seedBlockedTerms', () => {
  useTestDb()

  it('creates one BlockedTerm per spec, owned by the given user', async () => {
    const [ada] = await seedUsers()

    const created = await seedBlockedTerms(ada._id)

    expect(created).to.have.length(blockedTermSpecs.length)
    const stored = await BlockedTerm.find().sort({ term: 1 })
    expect(stored).to.have.length(blockedTermSpecs.length)
    expect(stored.every((term) => term.createdBy.toString() === ada._id.toString())).to.equal(true)
  })

  it('includes a block term, a flag term, and a term suppressed by the allowlist', async () => {
    const [ada] = await seedUsers()

    await seedBlockedTerms(ada._id)

    const severities = await BlockedTerm.find().distinct('severity')
    expect(severities).to.include('block')
    expect(severities).to.include('flag')
    const substringTerm = await BlockedTerm.findOne({ matchType: 'substring' })
    expect(substringTerm.term).to.equal('ass')
  })
})
