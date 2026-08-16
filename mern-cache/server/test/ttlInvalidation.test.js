import { expect } from 'chai'
import { createStore } from '../src/cache/store.js'
import { createCache } from '../src/cache/productCache.js'

function makeOrigin(data) {
  const state = { calls: 0 }
  async function loader(key) {
    state.calls += 1
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
  }
  return { loader, state, data }
}

describe('TTL expiry versus explicit invalidation', () => {
  it('reloads from the origin once the entry TTL has elapsed', async () => {
    const { loader, state } = makeOrigin({ p1: { id: 'p1', priceCents: 100 } })
    const cache = createCache({ store: createStore(), loader, ttlMs: 1000 })

    const cold = await cache.get('p1', 0)
    const warm = await cache.get('p1', 500)
    const expired = await cache.get('p1', 1500)

    expect(cold.source).to.equal('origin')
    expect(warm.source).to.equal('cache')
    expect(expired.source).to.equal('origin')
    expect(state.calls).to.equal(2)
  })

  it('serves a stale value after the origin changes, until the key is invalidated on write', async () => {
    const { loader, state, data } = makeOrigin({ p1: { id: 'p1', priceCents: 100 } })
    const cache = createCache({ store: createStore(), loader, ttlMs: 100000 })

    const first = await cache.get('p1', 0)
    data.p1 = { id: 'p1', priceCents: 250 }
    const stale = await cache.get('p1', 1)
    cache.invalidate('p1')
    const fresh = await cache.get('p1', 2)

    expect(first.value.priceCents).to.equal(100)
    expect(stale.value.priceCents).to.equal(100)
    expect(stale.source).to.equal('cache')
    expect(fresh.value.priceCents).to.equal(250)
    expect(state.calls).to.equal(2)
  })

  it('stamps the TTL when the loaded value is stored, not when the miss began', async () => {
    const state = { calls: 0 }
    let release
    const gate = new Promise((resolve) => { release = resolve })
    async function loader() {
      state.calls += 1
      if (state.calls === 1) await gate
      return { id: 'p1', priceCents: 100 }
    }
    let t = 0
    const cache = createCache({ store: createStore(), loader, ttlMs: 1000, clock: () => t })

    const pending = cache.get('p1', 0)
    t = 900
    release()
    await pending
    const warm = await cache.get('p1', 1500)

    expect(warm.source).to.equal('cache')
    expect(state.calls).to.equal(1)
  })

  it('drops an in-flight load when the key is invalidated so the stale result is never cached', async () => {
    const state = { calls: 0 }
    const data = { p1: { id: 'p1', priceCents: 100 } }
    let release
    const gate = new Promise((resolve) => { release = resolve })
    async function loader(key) {
      state.calls += 1
      const snapshot = data[key]
      if (state.calls === 1) await gate
      return snapshot
    }
    const cache = createCache({ store: createStore(), loader, ttlMs: 100000 })

    const pending = cache.get('p1', 0)
    data.p1 = { id: 'p1', priceCents: 250 }
    cache.invalidate('p1')
    const fresh = cache.get('p1', 0)
    release()
    const stale = await pending
    const reloaded = await fresh
    const after = await cache.get('p1', 1)

    expect(stale.value.priceCents).to.equal(100)
    expect(reloaded.source).to.equal('origin')
    expect(reloaded.value.priceCents).to.equal(250)
    expect(after.source).to.equal('cache')
    expect(after.value.priceCents).to.equal(250)
    expect(state.calls).to.equal(2)
  })
})
