# Scheduler

## What this is

The loop that decides *when* due work actually happens, and hands it off to
whatever should do the work. `src/scheduler/tick.js` exports `tick(pool)`,
which any number of app instances can call on their own interval (`src/index.js`
calls it every `TICK_INTERVAL_MS`), and exactly one instance's call does
anything on any given pass — the rest return immediately having done nothing.
`src/scheduler/registry.js` is the seam between "decide when" and "do the
work": a schedule's due occurrence is executed inline through a handler
looked up by the schedule's `name`, and the README for the app as a whole
says plainly that a production system would replace that inline call with
handing the occurrence to a queue (`sql-jobs`) instead — this module's job
ends at "this occurrence is due, and here is its outcome," not at "reliably
retry it forty times with a dead-letter queue."

## How it works here

**The tick.** `runDueSchedules(pool)` (`src/scheduler/tick.js:72-91`) asks the
database for its own current time (`schedulesRepo.currentTime`,
`src/repositories/schedules.js:26-29` — `SELECT now()`, never
`new Date()` in application code) and every active schedule whose
`next_run_at` is at or before that instant (`schedulesRepo.findDue`,
same file, also filtering with `now()` inside the query itself). Each due
schedule is processed inside its own transaction
(`withTransaction(processSchedule)`) *and* its own `try`/`catch`, so one
schedule's failure can't corrupt another's bookkeeping or stop the tick from
reaching the rest of the due list. This isolation was missing for a while:
`runDueSchedules` originally awaited each schedule in a plain loop with no
per-schedule guard, so a schedule whose cadence or timezone was bad enough to
throw (an invalid IANA zone name reaching `Intl.DateTimeFormat` inside
`nextOccurrence`, say) aborted every later schedule in the same pass. A
schedule that throws now gets a failure recorded on a run instead
(`recordScheduleFailure`, `src/scheduler/tick.js:61-70`) and the loop moves
on. The reachable version of this bug was `POST /api/schedules` accepting an
invalid IANA timezone name outright (`services/schedules.js` validated the
cadence but not the timezone) — fixed at the source with `isValidTimeZone`
(`src/cadence/README.md`) so a schedule with a bad timezone is rejected with
`400` before it can ever reach the tick at all; the per-schedule isolation
above is the defense for whatever bad data still gets in some other way (a
direct database edit, a future code path that skips validation), not a
substitute for validating at the door.

**The failure handler is itself guarded, and its own call site is guarded a
second time.** `recordScheduleFailure` inserts a `runs` row keyed on the
schedule's own `next_run_at` with `status: 'failure'` and the original error
message, so the schedule stays visibly stuck rather than silently skipped —
but the very first version of this fix isolated `processSchedule` and left
`recordScheduleFailure` itself unguarded, so a failure *while recording the
failure* (the transaction can't get a connection, the insert itself throws
for some unrelated reason) aborted the remaining due list exactly the way
the original bug did, one level down. Error handlers that can themselves
fail are a general trap, not specific to this app: the handler runs
precisely when something has already gone wrong, which makes it the least
likely code path to be healthy at that moment and — because "the error path
of the error path" is an easy thing to never think to test — the least
likely to have been exercised at all. The fix is two guards, not one:
`recordScheduleFailure`'s own body catches and logs whatever its DB write
throws (`src/scheduler/tick.js:61-70`), and `runDueSchedules`'s call site
*also* wraps the call in its own `try`/`catch` (`src/scheduler/tick.js:82-85`)
so the loop survives even if a future change strips the inner guard, or (as
in the test) the recording function is replaced entirely. `runDueSchedules`
accepts an optional `{ recordScheduleFailure }` override for exactly this —
the same injectable-dependency pattern `deliverWithRetry` already uses for
`fetchImpl`/`sleep` — because forcing this specific failure through a real
database fault would need either a timing-dependent race (the schedule row
would have to vanish between being fetched as due and the failure write,
which `findDue` and the write happen too close together in the same call to
arrange without genuine concurrency) or a contrived one; the override makes
the test for "recording the failure throws, and later schedules still run"
deterministic instead. A concurrency test that doesn't force the actual
interleaving proves only that the code runs twice — see
`src/alerting/README.md` for where that lesson was learned the hard way, on
this same branch, on a different test.

**Exactly one instance decides — and two independent mechanisms enforce it,
for two different reasons.** `tick()` (`src/scheduler/tick.js:93-107`) first
takes `pg_try_advisory_lock` (`src/repositories/lock.js`) — non-blocking: if
another instance already holds it, this call returns `{ acquired: false }`
immediately and does no work at all. That is the *liveness* half: it stops
duplicate work from ever starting, so ten instances polling the same table
don't all execute the same content-publish action ten times over. But a lock
is inherently soft — a network partition can strand a lock holder mid-tick, a
process can be killed between acquiring the lock and finishing its work, and
Postgres's advisory locks are session-scoped, so a dead session eventually
releases one it never explicitly unlocked, but "eventually" is exactly the
window a second instance can slip through. So `runs` also carries a
`UNIQUE (schedule_id, occurrence_at)` constraint (`src/migrations/003_create_runs.sql`)
— the *safety* half: even if two instances both believe they hold the lock
(or the lock is bypassed entirely — see the test below), only one of them can
ever successfully insert a `runs` row for a given occurrence. The loser's
insert raises a `23505` unique-violation, which
`runsRepo.createGuarded` (`src/repositories/runs.js`) catches inside a
`SAVEPOINT`/`ROLLBACK TO SAVEPOINT` pair so the failed insert doesn't poison
the rest of that transaction — a real bug caught while building this: without
the savepoint, the unique-violation left the whole transaction in Postgres's
"current transaction is aborted" state, so the subsequent
`next_run_at` update failed too, taking down bookkeeping that had nothing to
do with the conflict. **A lock is a liveness mechanism; a constraint is a
safety one.** The lock is what makes the common case cheap (only one instance
ever does the query and the work); the constraint is what makes the rare case
survivable (the lock failed, but the data still can't become inconsistent).
Neither replaces the other — a constraint alone would let every instance
redundantly execute a due occurrence's side effects before losing the insert
race; a lock alone has no defense against the moment it fails.

`test/scheduler.test.js` proves both halves directly, not by inference: one
test races two real `tick(pool)` calls with `Promise.all` and asserts exactly
one of them reports `acquired: true` and exactly one `runs` row exists — a
real race between two database connections, not a coincidence of which
`Promise` the JS event loop happened to schedule first, since
`pg_try_advisory_lock` is what actually serializes them. A second test calls
`runDueSchedules(pool)` — the unlocked inner function — twice concurrently,
bypassing `tick()`'s lock entirely, and still gets exactly one `runs` row,
because the two transactions' inserts collide on the unique index and one
gets `23505`. That second test was rerun against the schema with the unique
constraint dropped, by hand, while building this feature, specifically to
confirm it goes red without the constraint — it does, with `expected [...] to
have a length of 1 but got 2` — and rerun again with the lock stubbed to
always return `true`, which also goes red, with `expected 2 to equal 1` on
the `acquired` count. Two different tests, two different failure signatures,
proving the two mechanisms are each pulling real weight rather than one of
them being redundant scaffolding the other would have covered anyway.

**Catch-up after downtime.** `collectBacklog` (`src/scheduler/tick.js:12-22`)
walks forward from a schedule's `next_run_at` via `nextOccurrence` (never
adding a fixed duration by hand — the cadence module owns what "the next
occurrence" means) and collects every occurrence at or before the database's
current time. If the scheduler was down for six hours and a 15-minute
schedule missed 24 occurrences, this list has 24 entries, not 1.
`catchup_policy` decides what to do with that list (`processSchedule`,
`src/scheduler/tick.js:37-59`): `all` executes every one of them, in
chronological order (the list is already built forward, so no reordering is
needed — proven with an assertion against an independently-computed expected
list of occurrence instants, not by sorting the observed list and comparing
it to itself, which would pass unconditionally regardless of execution
order); `skip` executes exactly one — the most recent missed occurrence — and
resyncs `next_run_at` from there, dropping everything older; `none` executes
nothing and just advances `next_run_at` past the whole backlog silently. All
three share the same "resync point" (the last entry in the backlog) as the
anchor for computing the *next* `next_run_at`, so `skip` and `none` differ
only in whether that one occurrence actually runs, not in where the schedule
ends up afterward.

**Drift.** `next_run_at` is always computed as `nextOccurrence({ ..., after:
<the scheduled occurrence, or the resync point> })` — never `after: now()`
and never `after: <when the handler finished>`
(`src/scheduler/tick.js:46,51,56`). A schedule whose handler takes 120ms
instead of 1ms still produces the exact same next `next_run_at`, because the
grid is anchored to when the occurrence was *scheduled*, not to how long it
took to execute. The alternative — anchoring to `now()` after the handler
finishes — silently turns a 15-minute schedule into something slower every
time a run takes non-trivial time, and the drift compounds invisibly across a
day. `test/scheduler.test.js`'s drift test registers a handler that sleeps
120ms and asserts `next_run_at` still lands exactly one interval after the
original due instant; mutating the anchor from the resync point to `now`
breaks it immediately (and breaks the plain "advances on the original grid"
test too, since both share the same anchor).

**Deterministic jitter.** `jitterMs(scheduleId, periodMs, maxJitterMs)`
(`src/scheduler/jitter.js`) hashes the schedule's id with a small FNV-1a-style
function — deterministic, not `Math.random()` — into a delay bounded by
`min(maxJitterMs, periodMs - 1)`. Ten thousand schedules all due at `09:00`
hash to ten thousand different, but individually stable, delays: the same
schedule gets the same jitter on every restart, so a schedule doesn't
randomly change its effective fire time from one process lifetime to the
next, but ten thousand schedules stop firing in the same instant. Capping the
jitter strictly below the schedule's own period is what guarantees it can
never push an occurrence into the neighbouring period — a jitter of, say,
20 minutes on a 15-minute schedule would be nonsensical (it could land closer
to the *next* occurrence than the one it was meant to delay); capping at
`periodMs - 1` makes that impossible by construction, not by convention. This
module computes the jitter value; nothing here yet uses it to actually delay
a handler invocation, since with this app's data volumes a single tick
processing every due schedule inline is not itself a bottleneck — see "What
this toy skips" below.

## The core concepts

- **Why polling beats in-process timers here.** An in-process timer
  (`setTimeout` scheduled far in advance, or a per-schedule interval) dies
  the moment the process restarts, and every schedule using one needs its
  own recovery logic to notice it missed its window. Polling (`tick()` on a
  fixed interval, checking the database for what's due) needs exactly one
  recovery story — whatever is in `schedules.next_run_at` when the process
  comes back up is authoritative, because it was never trusted to survive in
  memory in the first place. The cost is latency granularity (a schedule can
  fire up to one tick interval late) and the query itself, both cheap at
  this app's scale; the benefit is that "the scheduler restarted" and "the
  scheduler is healthy" require no special-casing anywhere.
- **Where the handoff to a queue belongs.** This module decides *when*;
  `executeHandler` (`src/scheduler/registry.js`) is deliberately the entire
  surface of *how*. In production, the function registered here for a
  given schedule name would not do the work itself — it would enqueue a job
  in `sql-jobs` (leases, retries, dead-lettering, fairness — all explicitly
  out of scope for this app) and return immediately, so a slow or failing
  handler can never hold up the tick loop that has other schedules to get
  through. Building that queue here would be duplicating `sql-jobs`, not
  integrating with it — this app deliberately stops at "the occurrence is
  due, and this is what happened when we tried it."
- **What you give up by not using a broker with native delayed delivery.**
  A message broker with built-in delayed delivery (a delay queue, or
  scheduled message support like some cloud queues offer) hands off "run
  this in 4 hours" as a first-class primitive: the broker itself holds the
  delay, and there is no polling loop to write, no `next_run_at` column, no
  advisory lock to think about. What you give up by building on Postgres
  polling instead: that simplicity, and the ability to schedule an
  arbitrary one-off delay natively. What you get back: everything here is
  inspectable with plain SQL (`SELECT * FROM schedules WHERE next_run_at <
  now()` answers "what's overdue" without needing broker-specific tooling),
  the exactly-once story is a single unique index instead of trusting a
  broker's delivery guarantees, and there's no new infrastructure dependency
  for an app whose actual volume (per-account recurring content schedules)
  never approaches what a broker's delay queue is built for.

## Standard practice

- Guard exclusive work with both a lock (liveness, cheap, the common path)
  and a database constraint (safety, the fallback for when the lock fails) —
  never one alone.
- Compute the database's current time via a real `now()` query when a
  decision must be consistent across instances; never trust the app
  process's clock for anything that must agree across processes.
- Anchor recurring work to the scheduled instant, not to `now()` or to when
  the previous run finished, or the schedule silently drifts.
- State a catch-up policy explicitly per schedule rather than letting
  whatever the polling interval happens to produce become the policy by
  accident.
- Derive jitter deterministically from a stable id, not from a random number,
  so behaviour survives a restart; bound it strictly below the schedule's own
  period so it can never cross into a neighbouring occurrence.

## What this toy skips

- Actually delaying execution by the jitter value. A production scheduler
  handling enough load to need jitter would use it to spread the *start* of
  each handler invocation across the window, not merely compute a bounded
  deterministic number; this app's tick loop executes everything inline in
  one pass, so the value is derived and tested but not yet wired into a
  scheduling decision.
- Any retry, lease, or dead-letter mechanism for a handler that fails. A
  failed run is recorded as `status = 'failure'` with its error and left
  there — see `src/alerting/README.md` for how that failure is *noticed*, and
  the top-level README for why retrying it reliably is `sql-jobs`'s job, not
  this app's.
- Fairness or prioritization across schedules within a single tick — due
  schedules are processed in `id` order, not by how overdue they are or by
  any notion of tenant fairness.
- Horizontal partitioning of the tick itself (sharding schedules across
  instances by hash range, say) — every instance polls the same full table,
  and the advisory lock picks exactly one to act; that's fine at this app's
  scale and would need rethinking at a much larger one.

## Try it

```bash
cd sql-scheduler
npm install
cp .env.example .env
npm run migrate
npm run seed
npm run dev
```

With the dev server running, the tick loop fires every `TICK_INTERVAL_MS`
(default 5s). Watch `runs` accumulate for the seeded schedules:

```bash
psql "$DATABASE_URL" -c "select schedule_id, occurrence_at, started_at, status from runs order by occurrence_at desc limit 10;"
```

## Further reading

- [PostgreSQL docs, Advisory Locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS) —
  `pg_try_advisory_lock`'s actual semantics: session-scoped, non-blocking when
  you ask it to be, and why it is a liveness tool rather than a correctness
  guarantee on its own.
- [PostgreSQL docs, `SAVEPOINT`](https://www.postgresql.org/docs/current/sql-savepoint.html) —
  the mechanism that lets a single failed statement (here, a unique
  violation) be recovered from without aborting an entire transaction.
- Wikipedia, [Cron](https://en.wikipedia.org/wiki/Cron) — the traditional
  polling scheduler this module's tick loop is a cousin of, and the thing it
  differs from by making timezone and catch-up policy first-class per
  schedule instead of implicit in the server's local clock.
- Wikipedia, [Thundering herd problem](https://en.wikipedia.org/wiki/Thundering_herd_problem) —
  the general shape of the problem deterministic jitter exists to blunt.

Elsewhere in this repo: [`../cadence/README.md`](../cadence/README.md) for
`nextOccurrence`, the primitive every next-run-at computation in this module
is built on, and its own DST policies; [`../alerting/README.md`](../alerting/README.md)
for how a schedule falling behind (or simply not running) is noticed and
escalated, using the `occurrence_at` vs. `started_at` distinction this module
is careful to keep separate throughout.
