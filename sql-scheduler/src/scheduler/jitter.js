const DEFAULT_MAX_JITTER_MS = 60000

function hashToUint32(input) {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function jitterMs(scheduleId, periodMs, maxJitterMs = DEFAULT_MAX_JITTER_MS) {
  const cap = Math.min(maxJitterMs, Math.max(periodMs - 1, 0))
  if (cap <= 0) return 0
  return hashToUint32(String(scheduleId)) % cap
}
