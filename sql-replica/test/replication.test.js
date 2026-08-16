import { expect } from 'chai'
import { useTestDb, createAccountFixture } from './helpers.js'
import { createClock } from '../src/replication/clock.js'
import { createEnv } from '../src/replication/topology.js'
import { createSession } from '../src/replication/session.js'
import { writeDocument, readDocument } from '../src/replication/router.js'
import { tick } from '../src/replication/tick.js'

describe('replication', () => {
  useTestDb()

  describe('read routing: reads to the replica, writes to the primary', () => {
    it('a read right after a write returns the stale old value from the replica while the primary is fresh', async () => {
      const account = await createAccountFixture()
      const clock = createClock(0)
      const env = createEnv({ clock, replicas: [{ name: 'replica-1', lagMs: 5000 }], stickyMs: 0 })
      await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v0' })
      clock.set(6000)
      await tick(env)
      const write = await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v1' })

      const replicaRead = await readDocument(env, { accountId: account.id, docKey: 'k' })
      const primaryRead = await readDocument(env, { accountId: account.id, docKey: 'k', consistency: 'strong' })

      expect(write.source).to.equal('primary')
      expect(replicaRead.source).to.equal('replica')
      expect(replicaRead.body).to.equal('v0')
      expect(replicaRead.fresh).to.equal(false)
      expect(primaryRead.source).to.equal('primary')
      expect(primaryRead.body).to.equal('v1')
      expect(primaryRead.fresh).to.equal(true)
    })

    it('a strong read is routed to the primary and sees the newest write with no lag', async () => {
      const account = await createAccountFixture()
      const clock = createClock(0)
      const env = createEnv({ clock, replicas: [{ name: 'replica-1', lagMs: 5000 }], stickyMs: 0 })
      await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v1' })

      const strong = await readDocument(env, { accountId: account.id, docKey: 'k', consistency: 'strong' })

      expect(strong.source).to.equal('primary')
      expect(strong.body).to.equal('v1')
      expect(strong.fresh).to.equal(true)
    })
  })

  describe('read-your-writes fix (a): sticky-primary window', () => {
    it('without the window a fresh write is invisible on the replica; the sticky window routes the read to the primary', async () => {
      const account = await createAccountFixture()
      const clock = createClock(0)
      const env = createEnv({ clock, replicas: [{ name: 'replica-1', lagMs: 5000 }], stickyMs: 5000 })
      const session = createSession()
      await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v1', session })
      await tick(env)

      const plain = await readDocument(env, { accountId: account.id, docKey: 'k' })
      const sticky = await readDocument(env, { accountId: account.id, docKey: 'k', session, sticky: true })

      expect(plain.source).to.equal('replica')
      expect(plain.body).to.equal(null)
      expect(sticky.source).to.equal('primary')
      expect(sticky.body).to.equal('v1')
    })

    it('once the window elapses and the replica has caught up, the sticky read falls back to the replica', async () => {
      const account = await createAccountFixture()
      const clock = createClock(0)
      const env = createEnv({ clock, replicas: [{ name: 'replica-1', lagMs: 5000 }], stickyMs: 5000 })
      const session = createSession()
      await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v1', session })
      clock.set(6000)
      await tick(env)

      const afterWindow = await readDocument(env, { accountId: account.id, docKey: 'k', session, sticky: true })

      expect(afterWindow.source).to.equal('replica')
      expect(afterWindow.body).to.equal('v1')
      expect(afterWindow.fresh).to.equal(true)
    })
  })

  describe('read-your-writes fix (b): write-position token', () => {
    it('the token forces the read to the primary while no replica has reached that position', async () => {
      const account = await createAccountFixture()
      const clock = createClock(0)
      const env = createEnv({ clock, replicas: [{ name: 'replica-1', lagMs: 5000 }], stickyMs: 0 })
      const write = await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v1' })
      await tick(env)

      const tokenRead = await readDocument(env, { accountId: account.id, docKey: 'k', token: write.version })

      expect(tokenRead.source).to.equal('primary')
      expect(tokenRead.body).to.equal('v1')
      expect(tokenRead.fresh).to.equal(true)
    })

    it('once the replica has applied through the token position the same token read is served from the replica', async () => {
      const account = await createAccountFixture()
      const clock = createClock(0)
      const env = createEnv({ clock, replicas: [{ name: 'replica-1', lagMs: 5000 }], stickyMs: 0 })
      const write = await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v1' })
      clock.set(6000)
      await tick(env)

      const tokenRead = await readDocument(env, { accountId: account.id, docKey: 'k', token: write.version })

      expect(tokenRead.source).to.equal('replica')
      expect(tokenRead.position).to.be.at.least(write.version)
      expect(tokenRead.body).to.equal('v1')
    })
  })

  describe('monotonic reads', () => {
    it('successive unpinned reads across two replicas of different lag can go backwards in version', async () => {
      const account = await createAccountFixture()
      const clock = createClock(0)
      const env = createEnv({ clock, replicas: [{ name: 'replica-1', lagMs: 500 }, { name: 'replica-2', lagMs: 2500 }], stickyMs: 0 })
      await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v1' })
      clock.set(2000)
      await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v2' })
      clock.set(3000)
      await tick(env)

      const first = await readDocument(env, { accountId: account.id, docKey: 'k' })
      const second = await readDocument(env, { accountId: account.id, docKey: 'k' })

      expect(first.version).to.equal(2)
      expect(second.version).to.equal(1)
      expect(second.version).to.be.lessThan(first.version)
    })

    it('pinning the session to the highest version it has seen keeps successive reads non-decreasing', async () => {
      const account = await createAccountFixture()
      const clock = createClock(0)
      const env = createEnv({ clock, replicas: [{ name: 'replica-1', lagMs: 500 }, { name: 'replica-2', lagMs: 2500 }], stickyMs: 0 })
      const session = createSession()
      await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v1' })
      clock.set(2000)
      await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v2' })
      clock.set(3000)
      await tick(env)

      const first = await readDocument(env, { accountId: account.id, docKey: 'k', session, pinned: true })
      const second = await readDocument(env, { accountId: account.id, docKey: 'k', session, pinned: true })

      expect(first.version).to.equal(2)
      expect(second.version).to.equal(2)
      expect(second.version).to.be.at.least(first.version)
    })
  })

  describe('bounded staleness', () => {
    it('after a tick, every write older than lagMs is visible on the replica and nothing younger is', async () => {
      const account = await createAccountFixture()
      const clock = createClock(0)
      const env = createEnv({ clock, replicas: [{ name: 'replica-1', lagMs: 5000 }], stickyMs: 0 })
      await writeDocument(env, { accountId: account.id, docKey: 'k1', body: 'a' })
      clock.set(3000)
      await writeDocument(env, { accountId: account.id, docKey: 'k2', body: 'b' })
      clock.set(6000)
      await writeDocument(env, { accountId: account.id, docKey: 'k3', body: 'c' })
      clock.set(9000)
      await writeDocument(env, { accountId: account.id, docKey: 'k4', body: 'd' })
      clock.set(10000)
      await tick(env)

      const r1 = await readDocument(env, { accountId: account.id, docKey: 'k1' })
      const r2 = await readDocument(env, { accountId: account.id, docKey: 'k2' })
      const r3 = await readDocument(env, { accountId: account.id, docKey: 'k3' })
      const r4 = await readDocument(env, { accountId: account.id, docKey: 'k4' })

      expect(r1.body).to.equal('a')
      expect(r2.body).to.equal('b')
      expect(r3.body).to.equal(null)
      expect(r4.body).to.equal(null)
    })

    it('a write becomes visible on the replica exactly when it is older than lagMs, never before', async () => {
      const account = await createAccountFixture()
      const clock = createClock(0)
      const env = createEnv({ clock, replicas: [{ name: 'replica-1', lagMs: 5000 }], stickyMs: 0 })
      await writeDocument(env, { accountId: account.id, docKey: 'k', body: 'v1' })
      clock.set(4999)
      await tick(env)
      const beforeBound = await readDocument(env, { accountId: account.id, docKey: 'k' })
      clock.set(5000)
      await tick(env)
      const atBound = await readDocument(env, { accountId: account.id, docKey: 'k' })

      expect(beforeBound.body).to.equal(null)
      expect(atBound.body).to.equal('v1')
    })
  })
})
