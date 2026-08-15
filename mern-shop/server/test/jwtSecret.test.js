import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { expect } from 'chai'

const tokensUrl = 'file://' + path.resolve('src/session/tokens.js')

function importTokensModuleIn(env) {
  return spawnSync(process.execPath, ['-e', `import(${JSON.stringify(tokensUrl)}).catch((err) => { console.error(err.message); process.exit(1) })`], { env, encoding: 'utf8' })
}

describe('JWT_SECRET at startup', () => {
  it('throws a clear startup error when JWT_SECRET is unset, in production', () => {
    const env = { ...process.env, NODE_ENV: 'production' }
    delete env.JWT_SECRET

    const result = importTokensModuleIn(env)

    expect(result.status).to.not.equal(0)
    expect(result.stderr).to.include('JWT_SECRET')
  })

  it('throws a clear startup error when JWT_SECRET is unset, in the test environment too', () => {
    const env = { ...process.env, NODE_ENV: 'test' }
    delete env.JWT_SECRET

    const result = importTokensModuleIn(env)

    expect(result.status).to.not.equal(0)
    expect(result.stderr).to.include('JWT_SECRET')
  })

  it('loads without throwing when JWT_SECRET is set', () => {
    const env = { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'a-real-secret' }

    const result = importTokensModuleIn(env)

    expect(result.status).to.equal(0)
  })
})
