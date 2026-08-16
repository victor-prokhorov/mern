const DAY_MS = 24 * 60 * 60 * 1000

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function formatterFor(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short'
  })
}

function partsToComponents(parts) {
  const map = {}
  for (const part of parts) map[part.type] = part.value
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday]
  }
}

export function zonedComponents(timeZone, instant) {
  const parts = formatterFor(timeZone).formatToParts(instant)
  return partsToComponents(parts)
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export function offsetMs(timeZone, instantMs) {
  const flooredMs = Math.floor(instantMs / 1000) * 1000
  const components = zonedComponents(timeZone, new Date(flooredMs))
  const asUtc = Date.UTC(components.year, components.month - 1, components.day, components.hour, components.minute, components.second)
  return asUtc - flooredMs
}

export function calendarDatePlusDays(year, month, day, n) {
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + n)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

export function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

function findTransition(timeZone, searchStart, searchEnd, offsetStart) {
  let lo = searchStart
  let hi = searchEnd
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (offsetMs(timeZone, mid) === offsetStart) lo = mid
    else hi = mid
  }
  return hi
}

export function localToInstant(timeZone, { year, month, day, hour, minute, second = 0 }) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const searchStart = guess - DAY_MS
  const searchEnd = guess + DAY_MS
  const offsetStart = offsetMs(timeZone, searchStart)
  const offsetEnd = offsetMs(timeZone, searchEnd)
  if (offsetStart === offsetEnd) return { instant: guess - offsetStart, kind: 'normal' }
  const transitionInstant = findTransition(timeZone, searchStart, searchEnd, offsetStart)
  const localBefore = transitionInstant + offsetStart
  const localAfter = transitionInstant + offsetEnd
  if (offsetEnd > offsetStart) {
    if (guess >= localBefore && guess < localAfter) return { instant: transitionInstant, kind: 'gap' }
    if (guess < localBefore) return { instant: guess - offsetStart, kind: 'normal' }
    return { instant: guess - offsetEnd, kind: 'normal' }
  }
  if (guess >= localAfter && guess < localBefore) return { instant: guess - offsetStart, kind: 'ambiguous-first' }
  if (guess < localAfter) return { instant: guess - offsetStart, kind: 'normal' }
  return { instant: guess - offsetEnd, kind: 'normal' }
}
