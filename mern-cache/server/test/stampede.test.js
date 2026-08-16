import { expect } from 'chai'
import { createStore } from '../src/cache/store.js'
import { createCache } from '../src/cache/productCache.js'

function makeSlowOrigin(value, delayMs) {
  const state = { calls: 0 }
  async function loader() {
    state.calls += 1
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return value
  }
  return { loader, state }
}

describe('cache stampede / single-flight', () => {
  it('collapses N concurrent misses for one cold key into a single origin call', async () => {
    const { loader, state } = makeSlowOrigin({ id: 'p1', name: 'Widget' }, 25)
    const cache = createCache({ store: createStore(), loader, ttlMs: 1000 })

    const results = await Promise.all(Array.from({ length: 20 }, () => cache.get('p1')))

    expect(state.calls).to.equal(1)
    expect(results.filter((r) => r.source === 'origin')).to.have.length(1)
    expect(results.filter((r) => r.source === 'coalesced')).to.have.length(19)
    expect(results.every((r) => r.value.name === 'Widget')).to.equal(true)
  })

  it('without single-flight, every concurrent miss stampedes the origin', async () => {
    const { loader, state } = makeSlowOrigin({ id: 'p1', name: 'Widget' }, 25)
    const cache = createCache({ store: createStore(), loader, ttlMs: 1000, coalesce: false })

    await Promise.all(Array.from({ length: 20 }, () => cache.get('p1')))

    expect(state.calls).to.equal(20)
  })

  it('starts a fresh single flight only after the first load has settled', async () => {
    const { loader, state } = makeSlowOrigin({ id: 'p1', name: 'Widget' }, 10)
    const cache = createCache({ store: createStore(), loader, ttlMs: 1000 })

    await cache.get('p1')
    const second = await cache.get('p1')

    expect(second.source).to.equal('cache')
    expect(state.calls).to.equal(1)
  })

  it('propagates a loader failure to every coalesced waiter and caches nothing', async () => {
    const state = { calls: 0 }
    async function loader() {
      state.calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error('origin down')
    }
    const store = createStore()
    const cache = createCache({ store, loader, ttlMs: 1000 })

    const results = await Promise.all(
      Array.from({ length: 5 }, () => cache.get('p1').then(() => 'fulfilled', (err) => err.message))
    )
    const retry = await cache.get('p1').then(() => 'fulfilled', (err) => err.message)

    expect(results).to.deep.equal(Array.from({ length: 5 }, () => 'origin down'))
    expect(retry).to.equal('origin down')
    expect(store.size()).to.equal(0)
    expect(state.calls).to.equal(2)
  })
})
