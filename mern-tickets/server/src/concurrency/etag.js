const STRONG_ETAG_PATTERN = /^"(\d+)"$/

export function formatETag(version) {
  return `"${version}"`
}

export function readIfMatch(header) {
  if (header === undefined) return { status: 'missing' }
  const match = STRONG_ETAG_PATTERN.exec(header)
  if (!match) return { status: 'malformed' }
  return { status: 'ok', version: Number(match[1]) }
}
