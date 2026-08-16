const handlers = new Map()

export function registerHandler(name, handler) {
  handlers.set(name, handler)
}

export function clearHandlers() {
  handlers.clear()
}

async function defaultHandler() {
  return { status: 'success' }
}

export async function executeHandler(schedule, context) {
  const handler = handlers.get(schedule.name) || defaultHandler
  return handler(context)
}
