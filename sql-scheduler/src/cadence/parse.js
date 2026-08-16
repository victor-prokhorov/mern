const INTERVAL_PATTERN = /^every (\d+)(m|h)$/
const DAILY_PATTERN = /^daily at (\d{2}):(\d{2})$/
const WEEKLY_PATTERN = /^weekly on ([a-z,]+) at (\d{2}):(\d{2})$/

const WEEKDAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function assertValidTime(hour, minute, original) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error(`invalid cadence: ${original}`)
}

export function parseCadence(cadence) {
  if (typeof cadence !== 'string') throw new Error('invalid cadence: expected a string')
  const intervalMatch = cadence.match(INTERVAL_PATTERN)
  if (intervalMatch) {
    const value = Number(intervalMatch[1])
    const unit = intervalMatch[2]
    if (value <= 0) throw new Error(`invalid cadence: ${cadence}`)
    const ms = unit === 'm' ? value * 60 * 1000 : value * 60 * 60 * 1000
    return { type: 'interval', ms }
  }
  const dailyMatch = cadence.match(DAILY_PATTERN)
  if (dailyMatch) {
    const hour = Number(dailyMatch[1])
    const minute = Number(dailyMatch[2])
    assertValidTime(hour, minute, cadence)
    return { type: 'daily', hour, minute }
  }
  const weeklyMatch = cadence.match(WEEKLY_PATTERN)
  if (weeklyMatch) {
    const dayNames = weeklyMatch[1].split(',')
    const days = dayNames.map((name) => {
      if (!(name in WEEKDAY_NAMES)) throw new Error(`invalid cadence: ${cadence}`)
      return WEEKDAY_NAMES[name]
    })
    const hour = Number(weeklyMatch[2])
    const minute = Number(weeklyMatch[3])
    assertValidTime(hour, minute, cadence)
    return { type: 'weekly', days, hour, minute }
  }
  throw new Error(`invalid cadence: ${cadence}`)
}
