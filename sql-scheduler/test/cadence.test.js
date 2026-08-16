import { expect } from 'chai'
import { parseCadence, nextOccurrence, isValidTimeZone } from '../src/cadence/index.js'

describe('parseCadence', () => {
  it('parses an interval in minutes', () => {
    const cadence = parseCadence('every 15m')

    expect(cadence).to.deep.equal({ type: 'interval', ms: 15 * 60 * 1000 })
  })

  it('parses an interval in hours', () => {
    const cadence = parseCadence('every 2h')

    expect(cadence).to.deep.equal({ type: 'interval', ms: 2 * 60 * 60 * 1000 })
  })

  it('parses a daily wall-clock cadence', () => {
    const cadence = parseCadence('daily at 09:30')

    expect(cadence).to.deep.equal({ type: 'daily', hour: 9, minute: 30 })
  })

  it('parses a weekly wall-clock cadence restricted to weekdays', () => {
    const cadence = parseCadence('weekly on mon,thu at 18:00')

    expect(cadence).to.deep.equal({ type: 'weekly', days: [1, 4], hour: 18, minute: 0 })
  })

  it('rejects an unrecognised cadence string', () => {
    expect(() => parseCadence('sometimes at noon')).to.throw(/invalid cadence/)
  })

  it('rejects an invalid hour', () => {
    expect(() => parseCadence('daily at 25:00')).to.throw(/invalid cadence/)
  })

  it('rejects an invalid weekday name', () => {
    expect(() => parseCadence('weekly on mon,xyz at 18:00')).to.throw(/invalid cadence/)
  })

  it('rejects a weekday name that only resolves via the Object prototype chain', () => {
    expect(() => parseCadence('weekly on constructor at 09:00')).to.throw(/invalid cadence/)
    expect(() => parseCadence('weekly on toString at 09:00')).to.throw(/invalid cadence/)
    expect(() => parseCadence('weekly on hasOwnProperty at 09:00')).to.throw(/invalid cadence/)
  })

  it('rejects a zero-length interval', () => {
    expect(() => parseCadence('every 0m')).to.throw(/invalid cadence/)
  })
})

describe('isValidTimeZone', () => {
  it('accepts a real IANA zone name', () => {
    expect(isValidTimeZone('Europe/Paris')).to.equal(true)
  })

  it('rejects a string that is not a real zone name', () => {
    expect(isValidTimeZone('Not/AZone')).to.equal(false)
  })

  it('rejects non-string input without throwing', () => {
    expect(isValidTimeZone(null)).to.equal(false)
    expect(isValidTimeZone(undefined)).to.equal(false)
    expect(isValidTimeZone(42)).to.equal(false)
  })
})

describe('nextOccurrence: interval cadence', () => {
  it('adds the fixed duration to the previous occurrence', () => {
    const after = new Date('2024-01-01T00:00:00.000Z')

    const next = nextOccurrence({ cadence: parseCadence('every 15m'), timezone: 'UTC', after })

    expect(next.toISOString()).to.equal('2024-01-01T00:15:00.000Z')
  })

  it('is strictly after the given instant, never equal', () => {
    const after = new Date('2024-01-01T00:00:00.000Z')

    const next = nextOccurrence({ cadence: parseCadence('every 2h'), timezone: 'UTC', after })

    expect(next.getTime()).to.be.greaterThan(after.getTime())
  })
})

describe('nextOccurrence: daily cadence, normal days', () => {
  it('lands on the same day when the time has not yet passed', () => {
    const after = new Date('2024-01-15T05:00:00.000Z')

    const next = nextOccurrence({ cadence: parseCadence('daily at 09:30'), timezone: 'Europe/Paris', after })

    expect(next.toISOString()).to.equal('2024-01-15T08:30:00.000Z')
  })

  it('rolls to the next day when the time has already passed', () => {
    const after = new Date('2024-01-15T09:00:00.000Z')

    const next = nextOccurrence({ cadence: parseCadence('daily at 09:30'), timezone: 'Europe/Paris', after })

    expect(next.toISOString()).to.equal('2024-01-16T08:30:00.000Z')
  })

  it('is strictly after the given instant even when after is exactly the occurrence', () => {
    const first = new Date('2024-01-15T08:30:00.000Z')

    const next = nextOccurrence({ cadence: parseCadence('daily at 09:30'), timezone: 'Europe/Paris', after: first })

    expect(next.toISOString()).to.equal('2024-01-16T08:30:00.000Z')
  })
})

describe('nextOccurrence: weekly cadence', () => {
  it('picks the next matching weekday', () => {
    const after = new Date('2024-01-15T00:00:00.000Z')

    const next = nextOccurrence({ cadence: parseCadence('weekly on mon,thu at 18:00'), timezone: 'Europe/Paris', after })

    expect(next.toISOString()).to.equal('2024-01-15T17:00:00.000Z')
  })

  it('skips a non-matching weekday and lands on the following one', () => {
    const after = new Date('2024-01-15T17:00:00.000Z')

    const next = nextOccurrence({ cadence: parseCadence('weekly on mon,thu at 18:00'), timezone: 'Europe/Paris', after })

    expect(next.toISOString()).to.equal('2024-01-18T17:00:00.000Z')
  })
})

describe('nextOccurrence: DST spring forward, the skipped hour', () => {
  it('fires at the first valid instant after the gap when the wall clock time does not exist', () => {
    const after = new Date('2024-03-30T12:00:00.000Z')

    const next = nextOccurrence({ cadence: parseCadence('daily at 02:30'), timezone: 'Europe/Paris', after })

    expect(next.toISOString()).to.equal('2024-03-31T01:00:00.000Z')
  })
})

describe('nextOccurrence: DST autumn, the repeated hour', () => {
  it('fires once, on the first of the two occurrences', () => {
    const after = new Date('2024-10-26T12:00:00.000Z')

    const first = nextOccurrence({ cadence: parseCadence('daily at 02:30'), timezone: 'Europe/Paris', after })

    expect(first.toISOString()).to.equal('2024-10-27T00:30:00.000Z')
  })

  it('does not fire a second time for the repeated local hour, and moves to the next day instead', () => {
    const firstOccurrence = new Date('2024-10-27T00:30:00.000Z')

    const next = nextOccurrence({ cadence: parseCadence('daily at 02:30'), timezone: 'Europe/Paris', after: firstOccurrence })

    expect(next.toISOString()).to.equal('2024-10-28T01:30:00.000Z')
  })
})

describe('nextOccurrence: interval versus daily diverge across a DST boundary', () => {
  it('every 24h and daily at 09:00 land on different instants after spring forward', () => {
    const anchor = new Date('2024-03-30T08:00:00.000Z')

    const intervalNext = nextOccurrence({ cadence: parseCadence('every 24h'), timezone: 'Europe/Paris', after: anchor })
    const dailyNext = nextOccurrence({ cadence: parseCadence('daily at 09:00'), timezone: 'Europe/Paris', after: anchor })

    expect(intervalNext.toISOString()).to.equal('2024-03-31T08:00:00.000Z')
    expect(dailyNext.toISOString()).to.equal('2024-03-31T07:00:00.000Z')
    expect(intervalNext.getTime()).to.not.equal(dailyNext.getTime())
  })
})
