import { expect } from 'chai'
import { pool, withTransaction } from '../src/db.js'

describe('withTransaction', () => {
  it('preserves the original error and its code when ROLLBACK itself fails', async () => {
    const originalConnect = pool.connect.bind(pool)
    const businessError = new Error('duplicate key value violates unique constraint')
    businessError.code = '23505'
    const fakeClient = {
      async query(sql) {
        if (sql === 'BEGIN') return
        if (sql === 'ROLLBACK') throw new Error('terminating connection due to administrator command')
        throw businessError
      },
      release() {}
    }
    pool.connect = async () => fakeClient

    let caught
    try {
      await withTransaction(async () => {
        throw businessError
      })
    } catch (err) {
      caught = err
    }
    pool.connect = originalConnect

    expect(caught).to.equal(businessError)
    expect(caught.code).to.equal('23505')
    expect(caught.rollbackError).to.be.an('error')
    expect(caught.rollbackError.message).to.equal('terminating connection due to administrator command')
  })
})
