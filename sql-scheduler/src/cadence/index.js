import { parseCadence } from './parse.js'
import { zonedComponents, localToInstant, calendarDatePlusDays, weekdayOf } from './zonedTime.js'

const MAX_ITERATIONS = 400

function nextDailyOccurrence(cadence, timezone, after) {
  let { year, month, day } = zonedComponents(timezone, after)
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const { instant } = localToInstant(timezone, { year, month, day, hour: cadence.hour, minute: cadence.minute })
    if (instant > after.getTime()) return new Date(instant)
    ;({ year, month, day } = calendarDatePlusDays(year, month, day, 1))
  }
  throw new Error('nextOccurrence: no daily occurrence found within 400 days')
}

function nextWeeklyOccurrence(cadence, timezone, after) {
  let { year, month, day } = zonedComponents(timezone, after)
  const days = new Set(cadence.days)
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (days.has(weekdayOf(year, month, day))) {
      const { instant } = localToInstant(timezone, { year, month, day, hour: cadence.hour, minute: cadence.minute })
      if (instant > after.getTime()) return new Date(instant)
    }
    ;({ year, month, day } = calendarDatePlusDays(year, month, day, 1))
  }
  throw new Error('nextOccurrence: no weekly occurrence found within 400 days')
}

export function nextOccurrence({ cadence: cadenceInput, timezone, after }) {
  const cadence = typeof cadenceInput === 'string' ? parseCadence(cadenceInput) : cadenceInput
  if (cadence.type === 'interval') return new Date(after.getTime() + cadence.ms)
  if (cadence.type === 'daily') return nextDailyOccurrence(cadence, timezone, after)
  if (cadence.type === 'weekly') return nextWeeklyOccurrence(cadence, timezone, after)
  throw new Error(`nextOccurrence: unsupported cadence type ${cadence.type}`)
}

export { parseCadence }
