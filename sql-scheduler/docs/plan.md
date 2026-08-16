# Plan — sql-scheduler: scheduling, and alarming on what it schedules

A sixth app at the repo root, on Postgres. Its problem is **time correctness**: deciding *when* something should happen, across user timezones, surviving downtime, with exactly one instance deciding — and then noticing, and telling someone, when the schedule stops being met.

This is deliberately **not** a job queue. `sql-jobs` owns reliable asynchronous execution — leases, retries, dead-lettering, fairness. This app owns the clock and the alarm. Where the two meet, this app executes its due work **inline through a small executor**, and the README states plainly that a production system hands off to a queue at that boundary, cross-referencing `sql-jobs`.

Copy this file to `sql-scheduler/docs/plan.md` in the first commit.

**Branch:** `feat/sql-scheduler`. Commit per task, TDD red then green with the real failing output in each red commit body. Do not open a PR.

## Domain

Recurring content publishing per account, in the account's own timezone.

```
accounts       (id, name, timezone, created_at)
schedules      (id, account_id, name, cadence, timezone, next_run_at, last_run_at,
                catchup_policy, active, created_at)
runs           (id, schedule_id, occurrence_at, started_at, finished_at, status, error)
alert_rules    (id, kind, threshold, window_seconds, for_evaluations, cooldown_seconds, channel, active)
alerts         (id, rule_id, subject, state, opened_at, resolved_at, last_notified_at,
                occurrences, consecutive_breaches, consecutive_clears)
notifications  (id, alert_id, channel, payload, state, attempts, delivered_at, last_error)
```

`occurrence_at` is the *scheduled instant*, distinct from `started_at`, the instant work actually began. The gap between them is scheduling lag, and the alerting task uses it — the README must make that distinction early, because conflating the two is why "the job ran" and "the job ran on time" get confused.

All times `TIMESTAMPTZ`; every comparison uses the database clock via `now()`, never the app process clock, so two instances agree.

## Global constraints

- Dependencies exactly: `pg`, `dotenv`, `express`, `express-async-errors`, `cors`, `chai`, `chai-http`, `mocha`, `mocha-junit-reporter`, `mocha-multi-reporters`, `cross-env`. **No cron library, no date library, no scheduling library.** Timezone arithmetic is `Intl.DateTimeFormat` with `timeZone`.
- Postgres in Docker as `mern-postgres` at `postgres://postgres:postgres@127.0.0.1:5432`. Database `scheduler`, tests `scheduler_test`. Port **5005**.
- Copy the fixed migration runner from `sql-ledger/src/migrations/runner.js` — `pg_try_advisory_lock` with client-side retry plus `INVALID` index repair. The blocking version deadlocks against `CREATE INDEX CONCURRENTLY`.
- One module-scope `request.agent(app)` in `test/helpers.js`. Never per-call `request.execute(app)` — it spins a server per call and flakes under volume.
- Same layering, with `npm run lint:layers` copied from `sql-ledger/scripts/check-layers.js`. Parameterised queries only.
- No comments in source or tests. No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert. ESM with `.js` extensions.
- For every test the plan marks as carrying a lesson, mutate the implementation and confirm the test fails. A test that asserts a consequence the broken version also produces is vacuous, and this repo has shipped three of those.

---

## Task 1 — Cadence and timezone arithmetic

`src/cadence/` — a **pure module**, no database, no Express, so the whole thing is unit-testable. This is the heart of the app.

**Cadence forms**, parsed by hand:
- `every 15m` / `every 2h` — fixed interval from the previous occurrence.
- `daily at 09:30` — a wall-clock time in the schedule's timezone.
- `weekly on mon,thu at 18:00` — same, restricted to weekdays.

`nextOccurrence({ cadence, timezone, after })` returns the next instant strictly after `after`. Compute it by working in the target timezone with `Intl.DateTimeFormat`, never by adding fixed offsets — an offset is a property of an instant, not of a zone.

**The two DST anomalies, each with a stated policy and a real test.** These are the highest-value tests in the app:

- **Spring forward, the skipped hour.** `daily at 02:30` in `Europe/Paris` on the day clocks jump 02:00 → 03:00. That local time does not exist. Policy: fire at the first valid instant after the gap (03:00 local). Test it against a real DST date.
- **Autumn, the repeated hour.** The same rule on the day 03:00 → 02:00 repeats, so 02:30 local occurs twice. Policy: fire **once**, on the first occurrence. Test that the second pass does not produce a duplicate.

The README must explain why both policies are choices rather than facts, and what the alternatives cost.

Also cover: interval cadences are unaffected by DST because they are durations, not wall-clock times — and a test must prove that `every 24h` and `daily at 09:00` diverge across a DST boundary. That divergence is the single clearest demonstration of why the distinction matters, and most engineers have never seen it made concrete.

**Tests:** each cadence form; strictly-after semantics; both DST anomalies; the `every 24h` versus `daily at 09:00` divergence; an invalid cadence string is rejected with a clear error rather than silently producing garbage.

**README** — `src/cadence/README.md`. Concepts: instants versus wall-clock times versus durations; why `TIMESTAMPTZ` stores an instant and a local time plus a zone name is a different thing; the IANA database and why offsets are not zones; the two DST anomalies; why cron has no timezone story in most implementations; leap seconds and why you can ignore them but should know why; and the practical rule — store the user's intent (zone + rule), compute the instant at read time, never store a precomputed local time.

---

## Task 2 — The scheduler loop

`src/scheduler/`.

**The tick.** Find schedules with `next_run_at <= now()` and `active`, create a `runs` row for the occurrence, execute it through a small handler registry, record the outcome, and compute the next `next_run_at` from the cadence module.

**Exactly one instance decides.** Two app instances must not both run the same occurrence. Guard the tick with a Postgres advisory lock **and** make the run insert idempotent with a unique constraint on `(schedule_id, occurrence_at)`. Both, and the README must say why: **a lock is a liveness mechanism and a constraint is a safety one** — the lock stops the duplicate work, the constraint stops the duplicate record when the lock inevitably fails during a network partition or a paused process. Test the constraint directly by disabling the lock.

**Catch-up after downtime.** If the scheduler was down and a 15-minute schedule missed 24 occurrences, `catchup_policy` decides:
- `skip` — run once now, drop the backlog;
- `all` — enqueue every missed occurrence in order;
- `none` — do nothing, wait for the next natural occurrence.

Test all three. The README explains why `skip` is almost always right for notifications and almost always wrong for anything that accrues — and that "misfire handling" is the name to search for.

**Deterministic jitter.** Ten thousand schedules at `09:00` all fire at once. Spread execution with jitter derived from the schedule id, so it is stable across restarts rather than random per tick. Test determinism, and test that jitter never moves an occurrence into the previous or next period.

**Drift.** Compute the next occurrence from the **scheduled** `occurrence_at`, not from `now()` or from when the run finished. Otherwise every slow run pushes the schedule later, and by the end of a day a 15-minute schedule has silently become a 17-minute one. Test it: simulate a slow run and assert the following occurrence is still on the original grid.

**Tests:** two concurrent ticks produce exactly one run for an occurrence (proven with overlapping transactions, not luck); the unique constraint alone still prevents a duplicate with the lock disabled; all three catch-up policies; jitter is deterministic and bounded; drift does not accumulate; an inactive schedule produces nothing.

**README** — `src/scheduler/README.md`. Concepts: the tick loop and why polling beats in-process timers for anything that must survive a restart; singleton scheduling, leader election, and lock-versus-constraint; misfire and catch-up policies; drift and grid-anchored scheduling; the thundering herd and jitter; why the scheduler should decide *when* and delegate *how* (cross-reference `sql-jobs`); and what you give up by not using a broker with native delayed delivery.

---

## Task 3 — Alarming and notification

`src/alerting/`.

The point is not sending a message. It is that naive alerting produces noise nobody reads, and the mechanisms that fix that are the content.

**Rules over schedule health**, each a pure predicate over queried state so it is unit-testable:
- `missed_run` — a schedule whose `next_run_at` is older than a threshold with no corresponding run.
- `run_failure_rate` — failures over a window above a threshold, **with a minimum volume**, so three failures out of five does not page and three out of a thousand does not hide. Same shape as the circuit breaker's trip condition; say so and cross-reference `mern-tickets/server/src/circuitBreaker/README.md`.
- `scheduling_lag` — `started_at - occurrence_at` above a threshold. This is the signal that the scheduler is alive but falling behind, which no "did it run" check detects, and the README must explain why it is the one people forget.

**Alert lifecycle, not events.** An alert has state: `firing` → `resolved`. Re-evaluating a still-broken condition updates the existing alert and increments `occurrences`; it never creates a second. That deduplication is what separates an alerting system from a log.

**Hysteresis.** A condition oscillating around its threshold must not page repeatedly. Require `for_evaluations` consecutive breaches before firing, and the same number of consecutive clears before resolving. Test both directions.

**Cooldown and renotification.** A firing alert renotifies at most once per `cooldown_seconds`, and sends exactly one resolution notification. Test that a still-firing alert inside its cooldown produces no new notification.

**Delivery.** Notifications go to a webhook via `fetch` with `AbortSignal.timeout`, retried with exponential backoff and full jitter, and parked as failed after N attempts. Keep the retry local to this app — do not build a second job queue — and note in the README that `sql-jobs` is where this belongs in production.

**The trap, stated explicitly:** an alerting system that depends on the machinery it monitors goes silent exactly when you need it. Cover dead-man switches and out-of-band paths.

**Tests:** a firing condition creates one alert and one notification; re-evaluation while still firing does not duplicate; a flapping condition does not fire until it breaches `for_evaluations` times consecutively; recovery emits exactly one resolution; cooldown suppresses renotification; delivery failure retries and eventually parks; `scheduling_lag` fires when runs are happening but late — the case a liveness check misses.

**README** — `src/alerting/README.md`. Concepts: symptoms versus causes and why you alert on symptoms; alert fatigue as the primary failure mode of monitoring; deduplication, grouping, inhibition, silences; hysteresis and flapping; cooldown and renotification; what makes an alert actionable, cross-referencing `mern-tickets/server/src/observability/README.md`; the monitoring-monitors-itself trap and dead-man switches; SLOs and burn-rate alerting as what this becomes at scale; and on-call ergonomics — the alert nobody can act on trains people to ignore the ones they can.

---

## Task 4 — HTTP surface, seed, and the app README

Endpoints: create account, create schedule, list schedules with their next occurrence, list runs with lag, list alerts, resolve an alert manually, list notifications. Enough that the "Try it" walkthroughs are real.

Seed: accounts in at least three timezones including one that will cross a DST boundary soon, one schedule per cadence form, some historical runs with realistic lag, and a deliberately failing schedule so the alerting walkthrough has something to fire on.

`sql-scheduler/README.md` indexes the three topic guides. Add the app and its topics to the root `README.md` tables.

---

## Report

Write to `/private/tmp/claude-502/-Users-victor-p-mern/45166ac0-196d-4053-b8d5-e0370ad855fe/scratchpad/scheduler2-report.md`: per task what you built, TDD evidence, the full suite result, the layering lint output, every link fetched, any concern. Reply with status, branch, commits, one-line test summary, concerns, report path — under 15 lines.
