export function createStore() {
  const entries = new Map()
  function get(key, now = Date.now()) {
    const entry = entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      entries.delete(key)
      return undefined
    }
    return entry
  }
  function set(key, value, ttlMs, now = Date.now(), negative = false) {
    const entry = { value, negative, expiresAt: now + ttlMs }
    entries.set(key, entry)
    return entry
  }
  function invalidate(key) {
    return entries.delete(key)
  }
  function clear() {
    entries.clear()
  }
  function size() {
    return entries.size
  }
  return { get, set, invalidate, clear, size }
}
