import { expect, use } from 'chai'
import chaiHttp from 'chai-http'
import { pool } from '../src/db.js'
import { useTestDb, createAccount, makeTransfer as makeTransferShared, httpAgent } from './helpers.js'

use(chaiHttp)

function makeTransfer(fromAccountId, toAccountId, reference) {
  return makeTransferShared(fromAccountId, toAccountId, 1, reference)
}

async function keysetPage(query) {
  const res = await httpAgent.get('/api/transfers').query(query)
  return res
}

async function offsetPage(query) {
  const res = await httpAgent.get('/api/transfers/offset-demo').query(query)
  return res
}

describe('pagination', () => {
  useTestDb()

  it('demonstrates that offset pagination duplicates a row when a new row is inserted between page fetches, while keyset pagination does not', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    const r1 = await makeTransfer(alice.id, bob.id, 'ins-1')
    const r2 = await makeTransfer(alice.id, bob.id, 'ins-2')
    const r3 = await makeTransfer(alice.id, bob.id, 'ins-3')
    const r4 = await makeTransfer(alice.id, bob.id, 'ins-4')
    const r5 = await makeTransfer(alice.id, bob.id, 'ins-5')

    const keysetPage1 = await keysetPage({ limit: 2 })
    const offsetPage1 = await offsetPage({ limit: 2, offset: 0 })
    await makeTransfer(alice.id, bob.id, 'ins-6')
    const keysetPage2 = await keysetPage({ limit: 2, cursor: keysetPage1.body.nextCursor })
    const offsetPage2 = await offsetPage({ limit: 2, offset: 2 })

    const keysetIds1 = keysetPage1.body.transfers.map((t) => t.id)
    const keysetIds2 = keysetPage2.body.transfers.map((t) => t.id)
    const offsetIds1 = offsetPage1.body.transfers.map((t) => t.id)
    const offsetIds2 = offsetPage2.body.transfers.map((t) => t.id)
    expect(keysetIds1).to.deep.equal([r5.id, r4.id])
    expect(keysetIds2).to.deep.equal([r3.id, r2.id])
    expect(keysetIds1.some((id) => keysetIds2.includes(id))).to.equal(false)
    expect(offsetIds2.some((id) => offsetIds1.includes(id))).to.equal(true)
  })

  it('demonstrates that offset pagination skips a row when a row is deleted between page fetches, while keyset pagination does not', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    const r1 = await makeTransfer(alice.id, bob.id, 'del-1')
    const r2 = await makeTransfer(alice.id, bob.id, 'del-2')
    const r3 = await makeTransfer(alice.id, bob.id, 'del-3')
    const r4 = await makeTransfer(alice.id, bob.id, 'del-4')

    const keysetPage1 = await keysetPage({ limit: 2 })
    const offsetPage1 = await offsetPage({ limit: 2, offset: 0 })
    await pool.query('DELETE FROM entries WHERE transfer_id = $1', [r4.id])
    await pool.query('DELETE FROM transfers WHERE id = $1', [r4.id])
    const keysetPage2 = await keysetPage({ limit: 2, cursor: keysetPage1.body.nextCursor })
    const offsetPage2 = await offsetPage({ limit: 2, offset: 2 })

    const keysetIds2 = keysetPage2.body.transfers.map((t) => t.id)
    const offsetIds2 = offsetPage2.body.transfers.map((t) => t.id)
    expect(keysetIds2).to.deep.equal([r2.id, r1.id])
    expect(offsetIds2.includes(r2.id)).to.equal(false)
  })

  it('gives exact page boundaries when transfers share the same created_at', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    const r1 = await makeTransfer(alice.id, bob.id, 'tie-1')
    const r2 = await makeTransfer(alice.id, bob.id, 'tie-2')
    const r3 = await makeTransfer(alice.id, bob.id, 'tie-3')
    await pool.query('UPDATE transfers SET created_at = $1 WHERE id IN ($2, $3, $4)', ['2026-01-01T00:00:00Z', r1.id, r2.id, r3.id])

    const page1 = await keysetPage({ limit: 2 })
    const page2 = await keysetPage({ limit: 2, cursor: page1.body.nextCursor })

    const allIds = [...page1.body.transfers.map((t) => t.id), ...page2.body.transfers.map((t) => t.id)]
    expect(new Set(allIds).size).to.equal(3)
    expect(allIds).to.include.members([r1.id, r2.id, r3.id])
  })

  it('does not skip rows when the page boundary falls between transfers created within the same millisecond', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    const r1 = await makeTransfer(alice.id, bob.id, 'micro-1')
    const r2 = await makeTransfer(alice.id, bob.id, 'micro-2')
    const r3 = await makeTransfer(alice.id, bob.id, 'micro-3')
    await pool.query('UPDATE transfers SET created_at = $1 WHERE id = $2', ['2026-01-01T00:00:00.123100Z', r1.id])
    await pool.query('UPDATE transfers SET created_at = $1 WHERE id = $2', ['2026-01-01T00:00:00.123400Z', r2.id])
    await pool.query('UPDATE transfers SET created_at = $1 WHERE id = $2', ['2026-01-01T00:00:00.123900Z', r3.id])

    const page1 = await keysetPage({ limit: 2 })
    const page2 = await keysetPage({ limit: 2, cursor: page1.body.nextCursor })

    expect(page1.body.transfers.map((t) => t.id)).to.deep.equal([r3.id, r2.id])
    expect(page2.body.transfers.map((t) => t.id)).to.deep.equal([r1.id])
  })

  it('has no nextCursor on the last page', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    await makeTransfer(alice.id, bob.id, 'last-1')

    const page = await keysetPage({ limit: 20 })

    expect(page.body.nextCursor).to.equal(null)
  })

  it('rejects a malformed cursor with 400', async () => {
    const res = await keysetPage({ cursor: 'not-a-real-cursor!!' })

    expect(res).to.have.status(400)
  })

  it('rejects a well-formed but incomplete decoded cursor payload', async () => {
    const cursor = Buffer.from(JSON.stringify({})).toString('base64url')

    const res = await keysetPage({ cursor })

    expect(res).to.have.status(400)
  })

  it('rejects a decoded cursor whose id is not a digit string', async () => {
    const cursor = Buffer.from(JSON.stringify({ c: '2024-01-01T00:00:00.000Z', i: 'not-a-number' })).toString('base64url')

    const res = await keysetPage({ cursor })

    expect(res).to.have.status(400)
  })

  it('rejects a decoded cursor whose created-at is not a string', async () => {
    const cursor = Buffer.from(JSON.stringify({ c: 1704067200000, i: '5' })).toString('base64url')

    const res = await keysetPage({ cursor })

    expect(res).to.have.status(400)
  })

  it('clamps limit to the configured maximum', async () => {
    const alice = await createAccount({ name: 'alice' })
    const bob = await createAccount({ name: 'bob' })
    for (let i = 0; i < 101; i += 1) await makeTransfer(alice.id, bob.id, `clamp-${i}`)

    const page = await keysetPage({ limit: 100000 })

    expect(page.body.transfers.length).to.equal(100)
  })
})
