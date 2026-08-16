> **Scope note (post-brainstorm correction):** this app was originally briefed as `sql-scheduler`, covering all three topics below (queue, scheduler, alerting) against a content-publishing domain. Mid-build the scope was narrowed: this app is `sql-jobs` and builds **Task 1 (the queue core) and Task 4 (HTTP surface, seed, README) only** — Tasks 2 (scheduling) and 3 (alerting) are dropped entirely and belong to a separate app. The domain also changed from scheduled posts to outbound message delivery: `accounts`, `messages`, and a `send_message` job kind delivering to a fake upstream over `fetch`. Everything below this note is the original plan text, preserved verbatim for context — read Task 1 for what actually applies here, and ignore the scheduling/alerting tasks and the original schema/domain.
>
> A queue answers "how does this work get done, reliably, eventually"; a scheduler answers "when should it happen" — that boundary is why the two split into separate apps rather than staying one.

# Plan — sql-scheduler: async job queue, scheduling, and alerting

A fifth app at the repo root, on Postgres. The domain is deliberately the one the author works in: **scheduled content publishing with delivery attempts and failure alerting** — accounts, scheduled posts, a job queue that publishes them, and an alerting layer that notices when publishing starts failing.

Copy this file to `sql-scheduler/docs/plan.md` in the first commit.

**Branch:** `feat/sql-scheduler`. Commit per task, TDD red then green with the real failing output in each red commit body. Do not open a PR.

## Why a new app rather than extending sql-ledger

`sql-ledger` teaches the outbox: a relay that delivers *side effects of a transaction*. A job queue is a different thing — work submitted to be done later, with retries, leases, priority, fairness and a scheduler in front of it. Building it beside the outbox makes the distinction concrete, and the queue README must state it explicitly: an outbox publishes facts that already happened; a queue runs work that has not happened yet and may fail.

## Schema

```
accounts        (id, name, timezone, created_at)
posts           (id, account_id, body, scheduled_at, status, created_at)
jobs            (id, kind, payload, run_at, priority, status, attempts, max_attempts,
                 locked_at, locked_by, lease_expires_at, last_error, created_at, updated_at)
schedules       (id, account_id, kind, payload, cadence, timezone, next_run_at,
                 last_run_at, catchup_policy, active)
alerts          (id, rule, subject, state, opened_at, closed_at, last_notified_at, occurrences)
notifications   (id, alert_id, channel, payload, delivered_at, attempts, last_error)
```

Money is not involved; times are `TIMESTAMPTZ` throughout and the README must say why (a naive timestamp for a scheduled post is a bug waiting for a DST boundary).

## Global constraints

- Dependencies exactly: `pg`, `dotenv`, `express`, `express-async-errors`, `cors`, `chai`, `chai-http`, `mocha`, `mocha-junit-reporter`, `mocha-multi-reporters`, `cross-env`. Node built-ins expected — `node:http` for fake upstreams, global `fetch` with `AbortSignal.timeout`, `Intl` for timezone arithmetic. **No cron library, no queue library, no date library.** Building them is the point.
- Postgres runs in Docker as `mern-postgres` at `postgres://postgres:postgres@127.0.0.1:5432`. This app uses database `scheduler`, tests use `scheduler_test`, created by the test bootstrap.
- Port 5004 (5000 shop, 5001 tickets, 5002 ledger, 5003 movies).
- Same layering as every other app: `routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own **every** SQL statement. Copy `sql-ledger/scripts/check-layers.js` and wire `npm run lint:layers`.
- Parameterised queries only. Migration runner: copy the fixed one from `sql-ledger/src/migrations/runner.js` — `pg_try_advisory_lock` with client-side retry, and `INVALID` index repair. Do not reintroduce the blocking-lock deadlock.
- Test harness: one module-scope `request.agent(app)` in `test/helpers.js`. Do **not** use per-call `request.execute(app)` — it spins a fresh server per call and flakes under volume, which cost a full debugging cycle in `sql-ledger`.
- No comments in source or tests. No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert. ESM with `.js` extensions.
- A red run that aborts before the tests execute is a bad red.
- Seven-section READMEs, every further-reading URL fetched before inclusion.

---

## Task 1 — Scaffold, schema, and the queue core

`src/queue/`.

**Claiming work.** `claimJobs({ workerId, kinds, limit })` selects due jobs — `status = 'ready' AND run_at <= now()` — ordered by `priority DESC, run_at ASC, id ASC`, with `FOR UPDATE SKIP LOCKED`, and in the same statement marks them `running` with `locked_by`, `locked_at` and `lease_expires_at = now() + lease`. One statement, `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED) …  RETURNING *`.

This is the crucial difference from the ledger's outbox and the README must draw it: the outbox's claim **writes nothing**, so a crashed worker strands nothing. A queue's claim **mutates state**, so it needs a lease — and therefore a reaper, and therefore a fencing story. Cross-reference `mern-shop/server/src/idempotency/README.md`, which already documents what a lease without a fence costs.

**Lease expiry and the reaper.** `reapExpired()` returns jobs whose `lease_expires_at < now()` to `ready` and increments `attempts`. A worker whose lease has expired must not be able to complete or fail its job afterwards: `completeJob` and `failJob` match on `locked_by` **and** `locked_at`, so a superseded worker's write is a no-op. That is the fence.

**Heartbeats.** A long-running job extends its lease with `heartbeat(jobId, workerId)`, which also matches on `locked_by`. Long work either heartbeats or is reaped; the README explains why the lease must be shorter than the reaper's tolerance and longer than the slowest healthy job, and what a bad choice costs in each direction.

**Failure and retry.** `failJob` increments `attempts`, records `last_error`, and either reschedules with **exponential backoff and full jitter** or moves the job to `dead` once `attempts >= max_attempts`. Dead jobs must never block live ones.

**Handlers and idempotency.** A handler registry maps `kind` to an async function. Delivery is **at-least-once**, so handlers must be idempotent, and the demo `publish_post` handler proves it: publishing sets `posts.status = 'published'` only from `scheduled`, so a replayed job is a no-op rather than a double publish.

**Fairness.** `claimJobs` must not let one account with ten thousand queued posts starve every other account. Implement a per-account concurrency cap in the claim itself, and explain the alternatives in the README (weighted fair queueing, per-tenant queues, token buckets) with the tradeoffs.

**Worker loop.** `createWorker({ concurrency, pollMs })` with an overlap guard, graceful shutdown that stops claiming, finishes in-flight jobs within a timeout, and releases their leases rather than abandoning them.

**Tests that carry the lesson.** Each must fail against the obvious broken implementation, and you must verify that by mutation:
- two workers claiming concurrently never get the same job — proven by holding one claim open in an uncommitted transaction and asserting the second returns other rows **promptly** (plain `FOR UPDATE` must hang, not merely dedupe);
- a job whose lease expires is reclaimed, and the **original worker's later `completeJob` is a no-op** — the fence;
- a heartbeat prevents reaping;
- backoff grows and is jittered (assert bounds, not equality);
- a job exceeding `max_attempts` goes `dead` and a later healthy job still runs;
- the handler is idempotent: running the same job twice publishes once;
- fairness: one account's backlog does not starve another's job;
- graceful shutdown releases the lease of an in-flight job rather than leaving it locked until the reaper.

**README** — `src/queue/README.md`. Concepts: queue versus outbox versus stream; at-least-once and why exactly-once is a delivery fiction; visibility timeout / lease / fencing; the reaper and why a crashed worker must not need human intervention; retry, backoff, jitter, and why retries interact badly with a circuit breaker (cross-reference `mern-tickets/server/src/circuitBreaker/README.md`); dead-letter queues and what you actually do with them; priority inversion and starvation; fairness and multi-tenancy; poison messages; queue depth and lag as the two metrics that matter; when Postgres is enough and when you actually need SQS/Redis/Kafka — with the honest answer that most teams reach for a broker far earlier than they need one.

---

## Task 2 — Scheduling

`src/scheduler/`.

**Due-time scheduling.** A `schedules` row produces jobs. The scheduler runs periodically, finds schedules with `next_run_at <= now()`, enqueues a job, and computes the next occurrence.

**Cadence.** Support two forms: a fixed interval (`every 15m`), and a daily-at-wall-clock-time form (`daily at 09:30`). Parse them yourself — no cron library. A five-field cron subset is optional; if you implement it, test it hard, and if you do not, say so in the README rather than implying support.

**Timezones, which is the real content here.** `daily at 09:30` in `Europe/Paris` is a different instant in January and July. Compute the next occurrence in the account's timezone using `Intl.DateTimeFormat` with `timeZone`, never by adding fixed offsets. The README must cover the two DST edge cases explicitly, and there must be a test for each:
- **the skipped hour** — `daily at 02:30` on a spring-forward day, when 02:30 does not exist locally;
- **the repeated hour** — the same rule on an autumn day when 02:30 happens twice, and the rule must fire once, not twice.

State the policy chosen for each and why. This is the single most valuable part of this app for someone scheduling content across user timezones.

**Catch-up after downtime.** If the scheduler was down for six hours and a 15-minute schedule missed 24 runs, `catchup_policy` decides: `skip` (run once now, drop the backlog), `all` (enqueue every missed occurrence), or `none` (wait for the next natural occurrence). Test all three. The README explains why `skip` is almost always right for notifications and almost always wrong for billing.

**Singleton scheduling.** Two app instances must not both enqueue the same occurrence. Guard with a Postgres advisory lock, and make the enqueue idempotent anyway with a unique constraint on `(schedule_id, occurrence_at)` — belt and braces, because a lock is a liveness mechanism and a constraint is a safety one. The README must draw that distinction; it is the same lesson as the outbox's consumer idempotency.

**Jitter.** Ten thousand schedules at `09:00` produce a thundering herd. Spread enqueues with deterministic per-schedule jitter derived from the id, so the spread is stable across restarts rather than random each time.

**Clock skew.** All time comparisons use the database clock (`now()`), never the app process clock, so multiple instances agree. The README explains why, and what breaks if you mix them.

**Tests:** interval and daily cadences compute correct next occurrences; both DST cases; all three catch-up policies; two concurrent scheduler ticks enqueue exactly one job for an occurrence (proven with overlapping transactions, not luck); jitter is deterministic for a given schedule; a schedule marked inactive stops producing.

**README** — `src/scheduler/README.md`. Concepts: wall-clock versus monotonic time; why `TIMESTAMPTZ` and why storing a local time plus a zone name is not the same as storing an instant; DST and the two anomalies; cron semantics and their surprises (including that most cron implementations have no timezone story); catch-up policies and misfire handling; singleton scheduling, leader election, and lock-versus-constraint; jitter and the thundering herd; drift; the difference between "every 15 minutes" and "at :00, :15, :30, :45"; and how this composes with the queue — the scheduler decides *when*, the queue decides *how and how many times*.

---

## Task 3 — Alerting and notification

`src/alerting/`.

The point is not "send a message". It is that a naive alerting layer produces noise nobody reads, and the mechanisms that fix that are the content.

**Rules over the job tables.** At minimum: `job_failure_rate` (failures over a window exceeding a threshold, with a minimum volume — the same shape as the circuit breaker, and the README should say so and cross-reference it), `dead_letter_growth`, and `queue_lag` (oldest ready job's `run_at` older than a threshold, which is the single best queue health signal and the README must explain why depth alone is not).

**Alert lifecycle, not events.** An alert has state: `firing` → `resolved`. Re-evaluating a still-broken condition updates the existing alert and increments `occurrences`; it does **not** create a second alert. This is the deduplication that separates an alerting system from a log.

**Flap suppression.** A condition oscillating around its threshold must not page ten times a minute. Require the condition to hold for N consecutive evaluations before firing, and to clear for M before resolving. Test both.

**Cooldown and renotification.** A firing alert renotifies at most once per cooldown window, and sends exactly one resolution notification. Test that a still-firing alert inside its cooldown produces no new notification.

**Delivery.** Notifications go to a webhook via `fetch` with a timeout, and — this is the point of putting alerting in *this* app — **delivery is itself a queued job**, so it gets the retry, backoff and dead-lettering from Task 1 for free. The README should note the trap: an alerting system that depends on the thing it monitors will be silent exactly when you need it, and say what real systems do about it (out-of-band paths, heartbeats, dead-man switches).

**Severity and routing** by rule, with one channel implemented and the routing table extensible.

**Tests:** a firing condition creates one alert and one notification; re-evaluation while still firing does not duplicate; a flapping condition does not fire until it holds for N; recovery emits exactly one resolution; cooldown suppresses renotification; notification delivery failure retries via the queue and eventually dead-letters; `queue_lag` fires on an old ready job even when the queue is shallow.

**README** — `src/alerting/README.md`. Concepts: symptoms versus causes and why you alert on the former; SLOs, error budgets and burn-rate alerting as what this would become at scale; alert fatigue as the primary failure mode of monitoring; deduplication, grouping, inhibition, silences; flapping and hysteresis; cooldown and renotification; on-call ergonomics and what makes an alert actionable (cross-reference `mern-tickets/server/src/observability/README.md`); the monitoring-system-monitors-itself trap and dead-man switches; why paging on a metric nobody can act on trains people to ignore pages.

---

## Task 4 — HTTP surface, seed, and the app README

Endpoints: create account, create post with a `scheduled_at`, create a schedule, list jobs with filters, inspect the dead-letter queue, retry a dead job, list alerts. A small admin surface is what makes the "Try it" walkthroughs real.

Seed: a few accounts across different timezones, some scheduled posts, one schedule per cadence form, and a deliberately failing job kind so the dead-letter and alerting walkthroughs have something to show.

`sql-scheduler/README.md` indexes the three topic guides with run instructions. Add the app to the root `README.md` app table and its three topics to the topic table.

---

## Report

Write to `/private/tmp/claude-502/-Users-victor-p-mern/45166ac0-196d-4053-b8d5-e0370ad855fe/scratchpad/scheduler-report.md`: per task what you built, TDD evidence, the full suite result, the layering lint output, every link fetched, and any concern. Reply with status, branch, commits, one-line test summary, concerns, report path — under 15 lines.
