import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage()

export function runWithContext(store, fn) {
  return storage.run(store, fn)
}

export function getContext() {
  return storage.getStore() || null
}

export function setContextField(key, value) {
  const store = storage.getStore()
  if (store) store[key] = value
}
