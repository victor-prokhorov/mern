import { expect } from 'chai'
import { createStore } from '../src/cache/store.js'
import { createCache } from '../src/cache/productCache.js'

function makeOrigin(data, delayMs = 0) {
  const state = { calls: 0 }
  async function loader(key) {
    state.calls += 1
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
  }
  return { loader, state, data }
}

describe('cache-aside (lazy loading)', () => {
  it('loads from the origin on a miss and serves the second read from cache', async () => {
    const { loader, state } = makeOrigin({ p1: { id: 'p1', name: 'Widget' } })
    const cache = createCache({ store: createStore(), loader, ttlMs: 1000 })

    const first = await cache.get('p1')
    const second = await cache.get('p1')

    expect(first.source).to.equal('origin')
    expect(second.source).to.equal('cache')
    expect(second.value.name).to.equal('Widget')
    expect(state.calls).to.equal(1)
  })

  it('caches a miss so repeated reads for an absent key touch the origin once (negative caching)', async () => {
    const { loader, state } = makeOrigin({})
    const cache = createCache({ store: createStore(), loader, ttlMs: 1000, negativeTtlMs: 1000 })

    const first = await cache.get('ghost')
    const second = await cache.get('ghost')

    expect(first.value).to.equal(null)
    expect(first.source).to.equal('origin')
    expect(second.source).to.equal('negative')
    expect(state.calls).to.equal(1)
  })

  it('expires the negative entry on its own shorter TTL, then reloads', async () => {
    const { loader, state } = makeOrigin({})
    let t = 0
    const cache = createCache({ store: createStore(), loader, ttlMs: 100000, negativeTtlMs: 1000, clock: () => t })

    await cache.get('ghost')
    t = 500
    const withinNegative = await cache.get('ghost')
    t = 1500
    const afterNegative = await cache.get('ghost')

    expect(withinNegative.source).to.equal('negative')
    expect(afterNegative.source).to.equal('origin')
    expect(state.calls).to.equal(2)
  })
})
