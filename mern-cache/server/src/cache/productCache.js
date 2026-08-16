export function createCache(options) {
  const store = options.store
  const loader = options.loader
  const ttlMs = options.ttlMs
  const negativeTtlMs = options.negativeTtlMs ?? options.ttlMs
  const coalesce = options.coalesce ?? true
  const inflight = new Map()
  async function load(key, now) {
    const value = await loader(key)
    if (value == null) store.set(key, null, negativeTtlMs, now, true)
    else store.set(key, value, ttlMs, now, false)
    return { value, source: 'origin' }
  }
  async function get(key, now = Date.now()) {
    const entry = store.get(key, now)
    if (entry) return { value: entry.value, source: entry.negative ? 'negative' : 'cache' }
    if (coalesce && inflight.has(key)) {
      const shared = await inflight.get(key)
      return { value: shared.value, source: 'coalesced' }
    }
    const pending = load(key, now)
    if (coalesce) inflight.set(key, pending)
    try {
      return await pending
    } finally {
      if (coalesce) inflight.delete(key)
    }
  }
  function invalidate(key) {
    return store.invalidate(key)
  }
  function size() {
    return store.size()
  }
  return { get, invalidate, size }
}
