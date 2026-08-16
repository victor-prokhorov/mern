# Cadence

## What this is

A pure module — no database, no Express, no clock of its own — that turns a
human-written cadence string (`every 15m`, `daily at 09:30`,
`weekly on mon,thu at 18:00`) plus an IANA timezone name into the single next
instant that cadence should fire, strictly after a given instant. `parseCadence`
(`src/cadence/parse.js`) turns the string into a small object; `nextOccurrence`
(`src/cadence/index.js`) turns that object, a timezone, and an `after` instant
into the next `Date`. Nothing here touches Postgres or the app clock directly —
callers pass in whatever `after` they got from `now()` in the database, so this
module is exercised entirely with plain JavaScript `Date` objects in tests, no
fixtures, no migrations, no network.

## How it works here

Three cadence forms. `every 15m` / `every 2h` parses to `{ type: 'interval', ms }`
— a fixed duration, nothing more. `daily at 09:30` parses to
`{ type: 'daily', hour, minute }`. `weekly on mon,thu at 18:00` parses to
`{ type: 'weekly', days: [1, 4], hour, minute }`, where `days` is a set of
JavaScript `getUTCDay()`-style weekday indices (`0` = Sunday). An invalid string
— a bad unit, an hour outside `0-23`, an unrecognised weekday name, `every 0m`
— throws `Error('invalid cadence: ...')` rather than silently parsing to
something that never fires or fires constantly (`src/cadence/parse.js:11-41`).
A weekday name is checked with `Object.hasOwn`, not the `in` operator — `in`
walks the prototype chain, so `weekly on constructor at 09:00` would
otherwise resolve `'constructor'` to `Object.prototype.constructor` instead
of being rejected, handing a `Function` to code that expects a weekday
index.

`nextOccurrence({ cadence, timezone, after })` dispatches on `cadence.type`
(`src/cadence/index.js:29-35`). Interval cadences are trivial: `after.getTime() + ms`,
full stop — no timezone lookup happens at all, because a duration does not
care what timezone it is being added in. Daily and weekly cadences go through
`src/cadence/zonedTime.js`, the part that does real work.

The core primitive is `localToInstant(timeZone, { year, month, day, hour, minute })`
(`src/cadence/zonedTime.js:76-94`): given a *local* wall-clock reading in a
zone, find the instant it refers to. The naive approach — treat the local
numbers as UTC, then subtract the zone's current UTC offset — works for
almost every day of the year, but breaks exactly on the day the zone's offset
changes, which is the one day this module exists to get right. So
`localToInstant` first checks the offset a day before and a day after the
target instant (`offsetStart`, `offsetEnd`, `src/cadence/zonedTime.js:80-81`);
if they match, there is no nearby transition and the naive subtraction is
correct. If they differ, a binary search (`findTransition`,
`src/cadence/zonedTime.js:65-74`) locates the transition instant to
millisecond precision, and the target wall-clock reading is classified as
falling before it, after it, or inside the gap/overlap the transition creates
— see "The core concepts" below for exactly how.

One subtlety worth naming because it drew real blood while building this:
`offsetMs` (`src/cadence/zonedTime.js:48-53`) floors its input to the nearest
second before formatting. `Intl.DateTimeFormat` reports only whole seconds, so
formatting an instant that has a few hundred milliseconds of remainder and
then reconstructing a UTC timestamp from those (second-truncated) parts
produces an offset that is off by up to 999ms — invisible on any real
`occurrence_at` value, which is always a round instant, but fatal to the
binary search in `findTransition`, whose midpoints are arbitrary millisecond
values. Without the floor, the search does not converge on the real DST
transition at all; it converges on the first millisecond where the rounding
error itself crosses an integer-second boundary, off by minutes from the true
transition. This was caught by the DST tests below the first time the
implementation was written, and is exactly the kind of bug a test suite that
only checks non-DST days would never see.

`nextDailyOccurrence` and `nextWeeklyOccurrence` (`src/cadence/index.js:6-27`)
both walk forward one calendar day at a time — using `calendarDatePlusDays`,
plain UTC calendar arithmetic with no timezone conversion, because calendar
dates don't have a timezone — calling `localToInstant` for each candidate day
and returning the first result strictly after `after`. Weekly additionally
filters candidate days by `weekdayOf`, the day-of-week for that *calendar*
date (also timezone-independent: a calendar date's weekday doesn't change
depending on what zone you view it from). The loop is capped at 400
iterations as a safety net against an unreachable cadence, not because 400
iterations are ever expected to be needed — a weekly cadence needs at most 7.

## The core concepts

- **Spring forward, the skipped hour, stated as a policy choice.** EU clocks
  change twice a year; the spring change jumps *forward* once — in
  `Europe/Paris`, at 02:00 local on the last Sunday of March, clocks become
  03:00. `2024-03-31` was that day. The local time `02:30` never happens that
  day; it was never on any clock. A cadence of `daily at 02:30` has to decide
  what "the next occurrence" even means when the instant it names does not
  exist. This module's policy: **fire at the first valid instant after the
  gap** — here, `03:00` local, i.e. `2024-03-31T01:00:00.000Z`. The
  alternative policies, and what they cost: skip that day's occurrence
  entirely (costs a missed run, silently, which is worse for anything that
  must run every day without fail); or shift the target time forward by the
  gap's exact size (`02:30 + 1h = 03:30`, which is what a naive "just add the
  offset delta" implementation produces) — defensible, but it means the
  cadence's effective time-of-day silently moves once a year, which is a
  strange thing for an operator debugging "why did this run at 03:30 instead
  of 02:30" to discover. Firing at the boundary itself (`03:00`) is the
  choice made here because it is the smallest possible deviation from intent
  — as early as possible, given that the requested instant never existed —
  and it is a fixed, predictable instant rather than one that depends on how
  far into the gap the requested time happened to fall.
- **Autumn, the repeated hour, stated as a policy choice.** The reverse
  change jumps *backward* once — `Europe/Paris` at 03:00 local on the last
  Sunday of October becomes 02:00 again, so it is the hour *from* 02:00 *to*
  03:00 that repeats: 03:00 itself occurs once, but every local time
  strictly between 02:00 and 03:00 happens twice. `2024-10-27` was that day;
  `02:30` local happened once at `00:30 UTC` (still summer time, `UTC+2`)
  and again at `01:30 UTC` (winter time, `UTC+1`). A cadence of
  `daily at 02:30` naively evaluated against both instants would create two
  runs for what is unambiguously one calendar day's occurrence. This
  module's policy: **fire once, on the first of the two** — the earlier
  absolute instant, `00:30 UTC`. The alternative — firing on the second
  occurrence, or firing on both — the second is simply wrong for anything
  modelling "once a day"; firing on the second occurrence instead of the
  first is defensible (arguably more "final"), but this module picks the
  first because the strictly-after walk that already has to happen for
  "already ran today, move to tomorrow" falls out naturally from treating
  the first occurrence as *the* occurrence for that calendar day — the
  second physical occurrence of `02:30` is, from `nextOccurrence`'s point of
  view, just another instant that is not strictly after an `after` that
  already sits inside the ambiguous window, so the walk correctly advances
  to the next calendar day instead of re-firing. Both anomalies are a direct
  consequence of the same fact: **an offset is a property of an instant, not
  of a zone.** A zone (`Europe/Paris`) is a timeline of offsets that change
  on specific dates according to law, not a single fixed number. Any
  timezone arithmetic that starts by looking up "the" offset for a zone,
  rather than the offset *at a specific instant*, will be wrong twice a year
  in exactly these ways.
- **Instants, wall-clock times, and durations — three different things.**
  An *instant* is a single point on the universal timeline — what
  `TIMESTAMPTZ` stores, always normalized to UTC internally regardless of
  what timezone was used to write it; two instants can always be compared or
  subtracted unambiguously. A *wall-clock time* is a local reading — "2:30
  PM in `Europe/Paris`" — that refers to a *different* instant depending on
  the date, because the zone's offset from UTC changes; the same wall-clock
  reading is not the same instant on two different days, and — as the two
  anomalies above show — is sometimes zero instants (the gap) or two
  instants (the overlap) on a single day. A *duration* is a fixed span with
  no calendar or timezone attached at all — `15 minutes`, `24 hours`; adding
  a duration to an instant always produces another instant, unconditionally,
  regardless of what the wall clock says at either end. `daily at HH:MM` is
  a wall-clock time; `every Nh` is a duration. They look similar — both
  describe "how often" — but they answer a different question: a
  wall-clock cadence answers "what should the clock read locally," a
  duration cadence answers "how much time should elapse." The test
  `nextOccurrence: interval versus daily diverge across a DST boundary`
  proves they are not interchangeable: starting from the same instant,
  `every 24h` and `daily at 09:00` in `Europe/Paris` land one hour apart the
  day after a spring forward, because `every 24h` adds exactly 86,400,000
  milliseconds no matter what, while `daily at 09:00` re-derives "09:00
  local" against whatever offset is in effect that day. Neither is more
  correct than the other — they are correct answers to different questions,
  and picking the wrong cadence type for the job (a duration when you meant
  a wall-clock time, or vice versa) is a real, easy-to-make bug.
- **Why TIMESTAMPTZ is not "local time plus a zone name".** `TIMESTAMPTZ` in
  Postgres is stored as an instant (UTC internally); the "timezone" part of
  the name refers only to how it's displayed on the way in and out, not to
  what's stored. A column of `(local timestamp, zone name)` pairs —
  `TIMESTAMP` plus a `timezone text` column — is a fundamentally different,
  and more dangerous, representation: it stores a wall-clock reading that
  has to be reinterpreted through `localToInstant`-style logic *every time*
  it's compared to anything, and if the zone's rules change (a country
  abolishes DST, as several have; a government moves a transition date,
  which happens almost every year somewhere), old rows are wrong
  retroactively unless recomputed. `TIMESTAMPTZ` sidesteps all of that: once
  written, it names a fixed instant forever, and the practical rule this
  module follows is downstream of that fact — **store the user's intent
  (the cadence string and the timezone name), compute the instant fresh
  every time `nextOccurrence` is called, and never store a precomputed
  local time as if it were durable.** `schedules.next_run_at` is a
  `TIMESTAMPTZ` — a cached instant, recomputed on every tick — never a local
  time plus a zone.
- **The IANA database, and why offsets are not zones.** `Europe/Paris` is a
  name in the IANA Time Zone Database (`tzdata`), a versioned, continuously
  updated table of every timezone's full history of offset changes, DST
  rules, and abolitions, going back as far as records allow and forward as
  far as currently-legislated rules go. `UTC+1` is not a substitute for
  `Europe/Paris` — it's one row of that zone's history, true for part of the
  year and false for the rest. Any system that lets a user pick "UTC+1"
  instead of a named zone has silently frozen that user into never
  observing DST, which is usually not what they meant. Node's `Intl` API is
  backed by the operating system's copy of `tzdata` (via ICU), which is why
  this module can ask `Intl.DateTimeFormat` "what does `Europe/Paris` read
  at this instant" without shipping or maintaining any DST rule tables
  itself — and also why the DST transition *dates* used in the tests
  (2024-03-31, 2024-10-27) are not something this module computes or
  asserts; they come from `tzdata`, and the tests simply pick two real ones
  and check the policy against them.
- **Why cron has no timezone story.** Traditional `cron` schedules against
  the *server's* local wall clock (or against UTC, if the server or crontab
  is configured that way), with no per-schedule timezone concept at all — a
  `crontab` line `30 2 * * *` means "run at 02:30 in whatever zone this
  box's clock is set to," and if you want "02:30 in `Europe/Paris`" on a UTC
  server, you compute the UTC offset by hand and hope nobody DST-shifts
  under you. Some `cron` implementations added an opt-in `CRON_TZ=` variable
  decades after the original tool, but the core five-field spec has no
  notion of "this schedule belongs to this account, and this account is in
  this timezone" — which is exactly what per-schedule recurring content
  publishing needs, since two accounts on the same server can be in
  different zones. This module exists because that feature isn't something
  you bolt onto `cron`; it's a different data model (cadence *and*
  timezone, together, per schedule) evaluated fresh against the current
  `tzdata` rules, not against whatever zone the process happens to be
  running in.
- **Leap seconds.** Real leap seconds occasionally add an extra second to
  UTC (`23:59:60`) to keep it aligned with Earth's rotation. This module
  ignores them entirely, and that is almost always fine:
  `Intl.DateTimeFormat`, `Date.UTC`, and Postgres's `TIMESTAMPTZ` all model
  time as if leap seconds don't exist — a day is always exactly 86,400
  seconds to all of them — so a scheduler built on these primitives can't
  even observe a leap second happening. The one place it would matter is
  sub-second-precision alignment with true UTC across a leap-second
  boundary, which nothing in this domain (content publishing on a
  minutes-to-hours cadence) needs. Systems that do care (some financial and
  GPS-adjacent systems) either smear the leap second (Google's "leap
  smear," spreading it over a day) or track TAI (International Atomic Time,
  which has no leap seconds) instead of UTC — worth knowing this problem
  exists and how those systems solve it, even though nothing here needs to.

## Standard practice

- Store the cadence and timezone as given; compute the instant at read time,
  never store a precomputed local time as if it were the source of truth.
- Never look up "the" offset for a zone — always look up the offset *at a
  specific instant*, because it changes.
- State a DST edge-case policy explicitly (fire-once, fire-at-boundary) rather
  than letting whatever the underlying date library happens to do become the
  policy by accident.
- Test DST behaviour against real transition dates from `tzdata`, not
  synthetic ones — the whole point is exercising the zone's actual rules.
- Use a duration (`every Nh`) when the requirement is "this much time between
  runs," and a wall-clock cadence (`daily at HH:MM`) when it's "this time of
  day" — and know that a DST boundary is exactly where the two stop agreeing.

## What this toy skips

- Cadence forms beyond three: no `monthly`, no cron-style five-field syntax,
  no combinators ("last weekday of the month"). The three forms here cover
  the DST-relevant cases (duration vs. wall-clock, daily vs. weekly) without
  needing a general expression parser.
- Historical zone-rule changes within a single test run — the tests pin to
  two specific, already-happened transitions rather than asserting anything
  about future rule changes a government could still legislate.
- Sub-second cadence precision or leap-second awareness (see above).
- A calendar-arithmetic fast path for interval cadences that grid-aligns to a
  wall-clock boundary (e.g. "every 24h, but always at the same local
  wall-clock time") — this module's `interval` type is a pure duration by
  design, and grid-aligned daily behaviour is exactly what the `daily` type is
  for instead.

## In the real world (AWS / GCP)

- Managed schedulers have absorbed this module's hardest part: **EventBridge Scheduler** (AWS) and **Cloud Scheduler** (GCP) both take an IANA timezone per schedule and evaluate cron expressions against it through the provider's own tzdata, DST included — you stop owning `localToInstant`. What you still own is the *policy*: neither service lets you choose what happens to a `02:30` that never exists on spring-forward day; you get the provider's behaviour, documented or not. If your product has to promise "fires at the first valid instant after the gap," you have to test their behaviour against a real transition date exactly the way this module's tests do — the policy questions in this README don't disappear, they just stop being answerable by reading your own code.
- The storage rule is portable verbatim: store the cadence expression and the zone name (both services do exactly this), never a precomputed local time. DynamoDB, Firestore, Cloud SQL, RDS — `TIMESTAMPTZ`-equivalent instants for computed occurrences, strings for intent.
- If you need cadence math inside your own service anyway (previews of "next 5 occurrences," validation at write time), the production version of this module is a library that consumes tzdata — `Temporal` (now in Node), `luxon`, or Java's `java.time` — not hand-rolled `Intl` binary search. This module hand-rolls it to teach the mechanism; a real codebase should not.

## Try it

```js
import { parseCadence, nextOccurrence } from './src/cadence/index.js'

const cadence = parseCadence('daily at 02:30')
const before = new Date('2024-03-30T12:00:00.000Z')

console.log(nextOccurrence({ cadence, timezone: 'Europe/Paris', after: before }).toISOString())
// 2024-03-31T01:00:00.000Z — 03:00 local, the first valid instant after the
// skipped 02:00-03:00 hour

const beforeAutumn = new Date('2024-10-26T12:00:00.000Z')
const first = nextOccurrence({ cadence, timezone: 'Europe/Paris', after: beforeAutumn })
console.log(first.toISOString()) // 2024-10-27T00:30:00.000Z — the first of the two 02:30s

console.log(nextOccurrence({ cadence, timezone: 'Europe/Paris', after: first }).toISOString())
// 2024-10-28T01:30:00.000Z — not the second 02:30 the same day; the walk
// moved straight to the next calendar day
```

## Further reading

- [IANA Time Zone Database](https://www.iana.org/time-zones) — the actual
  source of truth this module leans on via `Intl`/ICU; the historical and
  scheduled-future offset data for every named zone.
- [Jon Skeet, *Storing UTC is not a silver bullet*](https://codeblog.jonskeet.uk/2019/03/27/storing-utc-is-not-a-silver-bullet/) —
  why "just store everything in UTC" is necessary but not sufficient the
  moment a recurring, wall-clock-anchored schedule is involved.
- [MDN, `Intl.DateTimeFormat`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat) —
  the only timezone-aware primitive this module uses; no date library was
  added to get zone-correct wall-clock arithmetic.
- [Wikipedia, *Daylight saving time by country*](https://en.wikipedia.org/wiki/Daylight_saving_time_by_country) —
  context for how arbitrary and jurisdiction-specific these transition rules
  are, and why hand-coding them instead of using `tzdata` would be a mistake.
- [Wikipedia, *Leap second*](https://en.wikipedia.org/wiki/Leap_second) — the
  mechanism this module (and `Date`/`TIMESTAMPTZ` generally) ignores, and why
  that's an accepted simplification almost everywhere.

Elsewhere in this repo: [`../scheduler/README.md`](../scheduler/README.md)
for how `nextOccurrence` is used to drive the tick loop, compute
grid-anchored `next_run_at` without drift, and decide catch-up behaviour
after downtime.
