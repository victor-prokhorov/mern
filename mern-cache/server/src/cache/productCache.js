export function createCache(options) {
  const store = options.store
  const loader = options.loader
  const ttlMs = options.ttlMs
  const negativeTtlMs = options.negativeTtlMs ?? options.ttlMs
  const coalesce = options.coalesce ?? true
  const clock = options.clock ?? Date.now
  const inflight = new Map()
  async function load(key, flight) {
    const value = await loader(key)
    if (!flight.invalidated) {
      if (value == null) store.set(key, null, negativeTtlMs, clock(), true)
      else store.set(key, value, ttlMs, clock(), false)
    }
    return { value, source: 'origin' }
  }
  async function get(key, now = clock()) {
    const entry = store.get(key, now)
    if (entry) return { value: entry.value, source: entry.negative ? 'negative' : 'cache' }
    if (coalesce && inflight.has(key)) {
      const shared = await inflight.get(key).promise
      return { value: shared.value, source: 'coalesced' }
    }
    const flight = { invalidated: false }
    const record = { promise: load(key, flight), flight }
    if (coalesce) inflight.set(key, record)
    try {
      return await record.promise
    } finally {
      if (coalesce && inflight.get(key) === record) inflight.delete(key)
    }
  }
  function invalidate(key) {
    const record = inflight.get(key)
    if (record) {
      record.flight.invalidated = true
      inflight.delete(key)
    }
    return store.invalidate(key)
  }
  function size() {
    return store.size()
  }
  return { get, invalidate, size }
}
