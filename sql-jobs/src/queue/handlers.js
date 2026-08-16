const handlers = new Map()

export function registerHandler(kind, fn, { onDead = null } = {}) {
  handlers.set(kind, { fn, onDead })
}

export function getHandler(kind) {
  const entry = handlers.get(kind)
  return entry ? entry.fn : null
}

export function getDeadHandler(kind) {
  const entry = handlers.get(kind)
  return entry ? entry.onDead : null
}

export function clearHandlers() {
  handlers.clear()
}
