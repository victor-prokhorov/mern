import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import Ticket from '../src/models/ticket.js'
import BlockedTerm from '../src/models/blockedTerm.js'
import { toNFKC, stripZeroWidth, toLowerCase, mapHomoglyphs, collapseRepeats, normalize } from '../src/moderation/normalize.js'
import { scan } from '../src/moderation/keywords.js'
import { seedUsers } from '../src/seed.js'
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

  it('persists flagged content with moderation metadata', async () => {
    const [ada, , , rae] = await seedUsers()
    await BlockedTerm.create({ term: 'suspicious', severity: 'flag', matchType: 'word', createdBy: ada._id })

    const res = await request
      .execute(app)
      .post('/api/tickets')
      .set('x-user-id', rae._id.toString())
      .send({ title: 'issue', body: 'this looks suspicious to me', priority: 'normal' })

    expect(res).to.have.status(201)
    expect(res.body.moderation.flagged).to.equal(true)
    expect(res.body.moderation.terms).to.deep.equal(['suspicious'])
    const count = await Ticket.countDocuments()
    expect(count).to.equal(1)
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
