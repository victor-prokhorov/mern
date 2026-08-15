import crypto from 'node:crypto'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => {
      acc[k] = canonicalize(value[k])
      return acc
    }, {})
  }
  return value
}

export function computeFingerprint(body) {
  const canonical = JSON.stringify(canonicalize(body || {}))
  return crypto.createHash('sha256').update(canonical).digest('hex')
}
