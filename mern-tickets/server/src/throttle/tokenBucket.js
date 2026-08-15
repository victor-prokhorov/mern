export const RATES = {
  'ticket:create': { burst: 5, refillPerMinute: 1 },
  'comment:create': { burst: 20, refillPerMinute: 5 }
}

export function computeRefill() {
  return 999
}

export function retryAfterSeconds() {
  return 0
}

export async function consume() {
  return { allowed: true, tokens: 999 }
}

export async function throttle() {
  return { allowed: true, tokens: 999 }
}
