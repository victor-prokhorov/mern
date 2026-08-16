import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Ticket from '../src/models/ticket.js'
import BlockedTerm from '../src/models/blockedTerm.js'
import { toNFKC, stripZeroWidth, toLowerCase, mapHomoglyphs, collapseRepeats, normalize } from '../src/moderation/normalize.js'
import { scan, ALLOWLIST, MIN_SUBSTRING_TERM_LENGTH } from '../src/moderation/keywords.js'
import { seedUsers, seedBlockedTerms, blockedTermSpecs } from '../src/seed.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

describe('normalization pipeline', () => {
  it('applies unicode NFKC normalization', () => {
    const result = toNFKC('ﬁle')

    expect(result).to.equal('file')
  })

  it('strips zero-width characters', () => {
    const result = stripZeroWidth('a​s‌s‍')

    expect(result).to.equal('ass')
  })

  it('lowercases text', () => {
    const result = toLowerCase('HELLO')

    expect(result).to.equal('hello')
  })

  it('maps leetspeak and homoglyphs to latin letters', () => {
    const result = mapHomoglyphs('p@ssw0rd')

    expect(result).to.equal('password')
  })

  it('maps cyrillic lookalikes to latin letters', () => {
    const result = mapHomoglyphs('аss')

    expect(result).to.equal('ass')
  })

  it('maps the canonical leetspeak digits and punctuation to latin letters', () => {
    const result = mapHomoglyphs('h3ll0 4ss cla55 k!ll')

    expect(result).to.equal('hello ass class kill')
  })

  it('collapses repeated letters', () => {
    const result = collapseRepeats('heeeello')

    expect(result).to.equal('helo')
  })

  it('composes every step into one normalized string', () => {
    const result = normalize('P@SSW00RD')

    expect(result).to.equal('pasword')
  })
})

describe('keyword matching', () => {
  it('lets an innocent word containing a blocked substring pass under word matching', () => {
    const terms = [{ term: 'cunt', matchType: 'word', severity: 'block' }]

    const matches = scan('I grew up in Scunthorpe', terms)

    expect(matches).to.deep.equal([])
  })

  it('still blocks the substring when matchType is substring', () => {
    const terms = [{ term: 'cunt', matchType: 'substring', severity: 'block' }]

    const matches = scan('I grew up in Scunthorpe', terms)

    expect(matches).to.have.length(1)
  })

  it('catches leetspeak evasion', () => {
    const terms = [{ term: 'password', matchType: 'word', severity: 'flag' }]

    const matches = scan('my p@ssw0rd is weak', terms)

    expect(matches).to.have.length(1)
    expect(matches[0].term).to.equal('password')
  })

  it('catches the canonical h3ll0 leetspeak evasion', () => {
    const terms = [{ term: 'hello', matchType: 'word', severity: 'flag' }]

    const matches = scan('h3ll0 there', terms)

    expect(matches).to.have.length(1)
    expect(matches[0].term).to.equal('hello')
  })

  it('catches elongation evasion', () => {
    const terms = [{ term: 'hello', matchType: 'word', severity: 'flag' }]

    const matches = scan('heeeello there', terms)

    expect(matches).to.have.length(1)
  })

  it('suppresses a match via the allowlist', () => {
    const terms = [{ term: 'ass', matchType: 'substring', severity: 'flag' }]

    const withoutAllowlist = scan('he is an assassin', terms)
    const withAllowlist = scan('he is an assassin', terms, ['assassin'])

    expect(withoutAllowlist).to.have.length(1)
    expect(withAllowlist).to.deep.equal([])
  })
})

describe('keyword blocking on ticket creation', () => {
  useTestDb()

  it('rejects content with a blocked term and persists nothing', async () => {
    const [ada, , , rae] = await seedUsers()
    await BlockedTerm.create({ term: 'unacceptable', severity: 'block', matchType: 'word', createdBy: ada._id })

    const res = await request
      .execute(app)
      .post('/api/tickets')
      .set('x-user-id', rae._id.toString())
      .send({ title: 'issue', body: 'this is unacceptable behavior', priority: 'normal' })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('content rejected')
    expect(res.body.error).to.not.include('unacceptable')
    const count = await Ticket.countDocuments()
    expect(count).to.equal(0)
  })

  it('persists flagged content with moderation metadata, without exposing the matched term to the reporter', async () => {
    const [ada, , , rae] = await seedUsers()
    await BlockedTerm.create({ term: 'suspicious', severity: 'flag', matchType: 'word', createdBy: ada._id })

    const res = await request
      .execute(app)
      .post('/api/tickets')
      .set('x-user-id', rae._id.toString())
      .send({ title: 'issue', body: 'this looks suspicious to me', priority: 'normal' })

    expect(res).to.have.status(201)
    expect(res.body.moderation.flagged).to.equal(true)
    expect(res.body.moderation).to.not.have.property('terms')
    const stored = await Ticket.findById(res.body._id)
    expect(stored.moderation.terms).to.deep.equal(['suspicious'])
    const count = await Ticket.countDocuments()
    expect(count).to.equal(1)
  })

  it('reveals the matched term to an agent in the same team, but never to the reporter', async () => {
    const [ada, gale, , rae] = await seedUsers()
    await BlockedTerm.create({ term: 'suspicious', severity: 'flag', matchType: 'word', createdBy: ada._id })
    const created = await request
      .execute(app)
      .post('/api/tickets')
      .set('x-user-id', rae._id.toString())
      .send({ title: 'issue', body: 'this looks suspicious to me', priority: 'normal' })

    const asReporter = await request.execute(app).get(`/api/tickets/${created.body._id}`).set('x-user-id', rae._id.toString())
    const asAgent = await request.execute(app).get(`/api/tickets/${created.body._id}`).set('x-user-id', gale._id.toString())

    expect(asReporter.body.ticket.moderation).to.not.have.property('terms')
    expect(asAgent.body.ticket.moderation.terms).to.deep.equal(['suspicious'])
  })

  it('does not flag content with no blocked terms', async () => {
    const [, , , rae] = await seedUsers()

    const res = await request
      .execute(app)
      .post('/api/tickets')
      .set('x-user-id', rae._id.toString())
      .send({ title: 'issue', body: 'everything is fine', priority: 'normal' })

    expect(res).to.have.status(201)
    expect(res.body.moderation.flagged).to.equal(false)
  })
})

describe('substring term length floor', () => {
  useTestDb()

  it('rejects a substring term that normalizes to fewer than the minimum characters', async () => {
    const [ada] = await seedUsers()

    const err = await BlockedTerm.create({ term: 'ass', severity: 'flag', matchType: 'substring', createdBy: ada._id }).catch((error) => error)

    expect(err).to.be.an.instanceOf(Error)
    expect(err.message).to.include(`substring terms must be at least ${MIN_SUBSTRING_TERM_LENGTH} characters after normalization`)
    expect(await BlockedTerm.countDocuments()).to.equal(0)
  })

  it('measures the floor after normalization, not as typed', async () => {
    const [ada] = await seedUsers()

    const err = await BlockedTerm.create({ term: 'hell', severity: 'block', matchType: 'substring', createdBy: ada._id }).catch((error) => error)

    expect(normalize('hell')).to.equal('hel')
    expect(err).to.be.an.instanceOf(Error)
    expect(err.message).to.include(`at least ${MIN_SUBSTRING_TERM_LENGTH} characters after normalization`)
  })

  it('accepts a substring term that is long enough after normalization', async () => {
    const [ada] = await seedUsers()

    const created = await BlockedTerm.create({ term: 'cunt', severity: 'flag', matchType: 'substring', createdBy: ada._id })

    expect(created.term).to.equal('cunt')
  })

  it('leaves word terms free to be short, because they match a whole token', async () => {
    const [ada] = await seedUsers()

    const created = await BlockedTerm.create({ term: 'ass', severity: 'flag', matchType: 'word', createdBy: ada._id })

    expect(created.term).to.equal('ass')
  })
})

describe('unmatchable terms', () => {
  useTestDb()

  it('rejects a multi-word term, which tokenization makes impossible to ever match', async () => {
    const [ada] = await seedUsers()

    const err = await BlockedTerm.create({ term: 'buy now', severity: 'block', matchType: 'word', createdBy: ada._id }).catch((error) => error)

    expect(err).to.be.an.instanceOf(Error)
    expect(err.message).to.include('single alphanumeric token')
    expect(await BlockedTerm.countDocuments()).to.equal(0)
  })

  it('rejects a term with punctuation inside it, for the same reason', async () => {
    const [ada] = await seedUsers()

    const err = await BlockedTerm.create({ term: 'e-mail', severity: 'flag', matchType: 'substring', createdBy: ada._id }).catch((error) => error)

    expect(err).to.be.an.instanceOf(Error)
    expect(err.message).to.include('single alphanumeric token')
  })
})

describe('substring precision against the seeded term list', () => {
  useTestDb()

  const innocent = [
    'The password reset link is broken.',
    'please open a case for this',
    'the glass broke',
    'a classic bug in the parser'
  ]

  for (const body of innocent) {
    it(`does not flag ${JSON.stringify(body)}`, async () => {
      const people = await seedUsers()
      await seedBlockedTerms(people[0]._id)

      const res = await request
        .execute(app)
        .post('/api/tickets')
        .set('x-user-id', people[3]._id.toString())
        .send({ title: 'issue', body, priority: 'normal' })

      expect(res).to.have.status(201)
      expect(res.body.moderation.flagged).to.equal(false)
    })
  }

  it('seeds no substring term that would fail the length floor', () => {
    const substringSpecs = blockedTermSpecs.filter((spec) => spec.matchType === 'substring')

    const tooShort = substringSpecs.filter((spec) => normalize(spec.term).length < MIN_SUBSTRING_TERM_LENGTH)

    expect(substringSpecs).to.not.have.length(0)
    expect(tooShort).to.deep.equal([])
  })

  it('still matches the seeded substring term, and still exempts the allowlisted word that contains it', () => {
    const substringSpecs = blockedTermSpecs.filter((spec) => spec.matchType === 'substring')

    const withAllowlist = scan('I grew up in Scunthorpe', substringSpecs, ALLOWLIST)
    const withoutAllowlist = scan('I grew up in Scunthorpe', substringSpecs, [])

    expect(withAllowlist).to.deep.equal([])
    expect(withoutAllowlist).to.have.length(1)
  })
})
