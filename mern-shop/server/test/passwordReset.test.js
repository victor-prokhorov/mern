import crypto from 'node:crypto'
import { expect, use } from 'chai'
import chaiHttp, { request } from 'chai-http'
import app from '../src/app.js'
import User from '../src/models/user.js'
import PasswordReset from '../src/models/passwordReset.js'
import { seedUser, seedUsers } from '../src/seed.js'
import { useTestDb } from './helpers.js'

use(chaiHttp)

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex')
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe('password reset', () => {
  useTestDb()

  it('returns a byte-identical response for a known and an unknown email when token exposure is off', async () => {
    await seedUsers()
    const previousValue = process.env.EXPOSE_RESET_TOKEN
    try {
      delete process.env.EXPOSE_RESET_TOKEN
      const known = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })
      const unknown = await request.execute(app).post('/api/auth/forgot-password').send({ email: 'nobody@shop.test' })
      expect(known).to.have.status(202)
      expect(unknown).to.have.status(202)
      expect(JSON.stringify(known.body)).to.equal(JSON.stringify(unknown.body))
    } finally {
      restoreEnv('EXPOSE_RESET_TOKEN', previousValue)
    }
  })

  it('returns the raw token in the response only when EXPOSE_RESET_TOKEN=1', async () => {
    await seedUsers()

    const res = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })

    expect(res).to.have.status(202)
    expect(res.body.token).to.be.a('string')
    expect(res.body.token).to.have.length(64)
  })

  it('omits the token when EXPOSE_RESET_TOKEN is not set to 1', async () => {
    await seedUsers()
    const previousValue = process.env.EXPOSE_RESET_TOKEN
    try {
      delete process.env.EXPOSE_RESET_TOKEN
      const res = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })
      expect(res).to.have.status(202)
      expect(res.body).to.not.have.property('token')
    } finally {
      restoreEnv('EXPOSE_RESET_TOKEN', previousValue)
    }
  })

  it('resets the password with a valid token and the new password logs in', async () => {
    const user = await seedUsers()
    const forgot = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })

    const res = await request.execute(app).post('/api/auth/reset-password').send({ token: forgot.body.token, password: 'correct-horse-battery' })
    const login = await request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: 'correct-horse-battery' })

    expect(res).to.have.status(200)
    expect(login).to.have.status(200)
    expect(login.body.email).to.equal(user.email)
  })

  it('the old password stops working after a reset', async () => {
    await seedUsers()
    const forgot = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })
    await request.execute(app).post('/api/auth/reset-password').send({ token: forgot.body.token, password: 'correct-horse-battery' })

    const login = await request.execute(app).post('/api/auth/login').send({ email: seedUser.email, password: seedUser.password })

    expect(login).to.have.status(401)
  })

  it('rejects a used token', async () => {
    await seedUsers()
    const forgot = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })
    await request.execute(app).post('/api/auth/reset-password').send({ token: forgot.body.token, password: 'correct-horse-battery' })

    const res = await request.execute(app).post('/api/auth/reset-password').send({ token: forgot.body.token, password: 'another-valid-passphrase' })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('reset token is invalid or expired')
  })

  it('rejects an expired token', async () => {
    const user = await seedUsers()
    const rawToken = 'a'.repeat(64)
    await PasswordReset.create({ user: user._id, tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() - 1000) })

    const res = await request.execute(app).post('/api/auth/reset-password').send({ token: rawToken, password: 'correct-horse-battery' })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('reset token is invalid or expired')
  })

  it('rejects an unknown token', async () => {
    await seedUsers()

    const res = await request.execute(app).post('/api/auth/reset-password').send({ token: 'unknowntoken', password: 'correct-horse-battery' })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('reset token is invalid or expired')
  })

  it('invalidates a second outstanding token after the first is used', async () => {
    await seedUsers()
    const first = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })
    const second = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })
    await request.execute(app).post('/api/auth/reset-password').send({ token: first.body.token, password: 'correct-horse-battery' })

    const res = await request.execute(app).post('/api/auth/reset-password').send({ token: second.body.token, password: 'another-valid-passphrase' })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('reset token is invalid or expired')
  })

  it('consumes a token exactly once under concurrent reset requests', async () => {
    await seedUsers()
    const forgot = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })

    const responses = await Promise.all([
      request.execute(app).post('/api/auth/reset-password').send({ token: forgot.body.token, password: 'first-valid-passphrase' }),
      request.execute(app).post('/api/auth/reset-password').send({ token: forgot.body.token, password: 'second-valid-passphrase' })
    ])

    const succeeded = responses.filter((res) => res.status === 200)
    const rejected = responses.filter((res) => res.status === 400)
    expect(succeeded).to.have.length(1)
    expect(rejected).to.have.length(1)
    expect(rejected[0].body.error).to.equal('reset token is invalid or expired')
  })

  it('rejects a short password', async () => {
    const user = await seedUsers()
    const forgot = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })

    const res = await request.execute(app).post('/api/auth/reset-password').send({ token: forgot.body.token, password: 'short' })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('password must be at least 15 characters')
    expect(await User.findById(user._id)).to.not.be.null
  })

  it('rejects an eight character password, which is the multi-factor floor and not this app design', async () => {
    await seedUsers()
    const forgot = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })

    const res = await request.execute(app).post('/api/auth/reset-password').send({ token: forgot.body.token, password: 'eightchr' })

    expect(res).to.have.status(400)
    expect(res.body.error).to.equal('password must be at least 15 characters')
  })

  it('accepts a password of exactly fifteen characters', async () => {
    await seedUsers()
    const forgot = await request.execute(app).post('/api/auth/forgot-password').send({ email: seedUser.email })

    const res = await request.execute(app).post('/api/auth/reset-password').send({ token: forgot.body.token, password: 'fifteenchars123' })

    expect(res).to.have.status(200)
    expect(res.body.message).to.equal('password has been reset')
  })
})
