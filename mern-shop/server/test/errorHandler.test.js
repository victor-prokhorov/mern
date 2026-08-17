import { expect } from 'chai'
import { errorHandler } from '../src/middleware/error.js'

describe('errorHandler', () => {
  it('logs an unhandled error before answering 500', () => {
    const calls = []
    const original = console.error
    console.error = (...args) => calls.push(args)
    const err = new Error('db exploded')
    const res = { status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }

    errorHandler(err, {}, res, () => {})

    console.error = original
    expect(res.code).to.equal(500)
    expect(calls.some((args) => args.includes(err))).to.equal(true)
  })

  it('does not log errors that map to a client status', () => {
    const calls = []
    const original = console.error
    console.error = (...args) => calls.push(args)
    const err = Object.assign(new Error('nope'), { status: 404 })
    const res = { status(code) { this.code = code; return this }, json(body) { this.body = body; return this } }

    errorHandler(err, {}, res, () => {})

    console.error = original
    expect(res.code).to.equal(404)
    expect(calls).to.deep.equal([])
  })
})
