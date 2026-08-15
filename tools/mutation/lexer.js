export function computeMutableMask(source) {
  const n = source.length
  const mask = new Uint8Array(n)
  let i = 0
  let state = 'code'
  let prevSignificant = ''
  const regexNotAllowedAfter = new Set([')', ']', '}'])
  function regexAllowed() {
    if (prevSignificant === '') return true
    if (/[A-Za-z0-9_$]/.test(prevSignificant)) return false
    if (regexNotAllowedAfter.has(prevSignificant)) return false
    return true
  }
  while (i < n) {
    const c = source[i]
    if (state === 'code') {
      if (c === '/' && source[i + 1] === '/') {
        state = 'linecomment'
        mask[i] = 0
        i += 1
        continue
      }
      if (c === '/' && source[i + 1] === '*') {
        state = 'blockcomment'
        mask[i] = 0
        i += 1
        continue
      }
      if (c === "'") {
        state = 'sqstring'
        mask[i] = 0
        i += 1
        continue
      }
      if (c === '"') {
        state = 'dqstring'
        mask[i] = 0
        i += 1
        continue
      }
      if (c === '`') {
        state = 'template'
        mask[i] = 0
        i += 1
        continue
      }
      if (c === '/' && regexAllowed()) {
        state = 'regex'
        mask[i] = 0
        i += 1
        continue
      }
      mask[i] = 1
      if (!/\s/.test(c)) prevSignificant = c
      i += 1
      continue
    }
    if (state === 'linecomment') {
      mask[i] = 0
      if (c === '\n') state = 'code'
      i += 1
      continue
    }
    if (state === 'blockcomment') {
      mask[i] = 0
      if (c === '*' && source[i + 1] === '/') {
        mask[i + 1] = 0
        i += 2
        state = 'code'
        continue
      }
      i += 1
      continue
    }
    if (state === 'sqstring' || state === 'dqstring') {
      mask[i] = 0
      const quote = state === 'sqstring' ? "'" : '"'
      if (c === '\\') {
        if (i + 1 < n) mask[i + 1] = 0
        i += 2
        continue
      }
      if (c === quote) {
        state = 'code'
        prevSignificant = ')'
        i += 1
        continue
      }
      i += 1
      continue
    }
    if (state === 'template') {
      mask[i] = 0
      if (c === '\\') {
        if (i + 1 < n) mask[i + 1] = 0
        i += 2
        continue
      }
      if (c === '`') {
        state = 'code'
        prevSignificant = ')'
        i += 1
        continue
      }
      if (c === '$' && source[i + 1] === '{') {
        mask[i] = 0
        mask[i + 1] = 0
        i += 2
        let depth = 1
        while (i < n && depth > 0) {
          const d = source[i]
          if (d === '{') depth += 1
          if (d === '}') depth -= 1
          if (depth === 0) {
            mask[i] = 0
            i += 1
            break
          }
          mask[i] = 1
          i += 1
        }
        continue
      }
      i += 1
      continue
    }
    if (state === 'regex') {
      mask[i] = 0
      if (c === '\\') {
        if (i + 1 < n) mask[i + 1] = 0
        i += 2
        continue
      }
      if (c === '[') {
        state = 'regexclass'
        i += 1
        continue
      }
      if (c === '/') {
        state = 'code'
        prevSignificant = ')'
        i += 1
        while (i < n && /[a-zA-Z]/.test(source[i])) {
          mask[i] = 0
          i += 1
        }
        continue
      }
      if (c === '\n') {
        state = 'code'
        continue
      }
      i += 1
      continue
    }
    if (state === 'regexclass') {
      mask[i] = 0
      if (c === '\\') {
        if (i + 1 < n) mask[i + 1] = 0
        i += 2
        continue
      }
      if (c === ']') {
        state = 'regex'
        i += 1
        continue
      }
      i += 1
      continue
    }
    i += 1
  }
  return mask
}

export function isMutableSpan(mask, start, end) {
  for (let i = start; i < end; i += 1) {
    if (mask[i] !== 1) return false
  }
  return true
}
