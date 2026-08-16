const handlers = new Map()

export function registerHandler(kind, fn) {
  handlers.set(kind, fn)
}

export function getHandler(kind) {
  return handlers.get(kind) || null
}

export function clearHandlers() {
  handlers.clear()
}
