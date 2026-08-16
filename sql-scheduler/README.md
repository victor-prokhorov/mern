# sql-scheduler

A Postgres-backed scheduling system with alarming. Its problem is **time correctness**: deciding *when* recurring content-publishing work should happen, per account, in the account's own timezone; surviving downtime without silently drifting or double-firing; guaranteeing exactly one instance decides, even though any number can be running; and then noticing, and telling someone, the moment the schedule stops being met.

This is deliberately **not a job queue**. [`sql-jobs`](../sql-jobs/) owns reliable asynchronous execution — leases, a reaper, retries, dead-lettering, fairness. This app owns the clock and the alarm. Where the two would meet, this app executes its due work inline through a small handler registry ([`src/scheduler/registry.js`](src/scheduler/registry.js)), and says so plainly: in production, that inline call would enqueue a job in `sql-jobs` and return immediately, instead of doing the work itself. Building a second queue here — a lease, a reaper, a dead-letter table — would be duplicating `sql-jobs`, not integrating with it; if you find retry machinery growing in this app beyond a single webhook's delivery attempts, that is drift out of scope, not a feature.

## The domain

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

`occurrence_at` is the *scheduled* instant a piece of work was due; `started_at` is the instant work actually began. The gap between them is scheduling lag, and it is the one signal a plain "did it run" check cannot see — a schedule can run every single occurrence and still be quietly falling behind. Every comparison against "now" throughout this app uses the database clock (`now()` inside a query), never the app process's own clock, so two instances of this app always agree on what's due.

## Layering

`routes/` wire, `controllers/` adapt HTTP, `services/` hold validation and orchestration, `repositories/` own every SQL statement — no SQL outside `repositories/` (the numbered files under `migrations/` are the documented DDL exception), no `req`/`res` in services or repositories. `npm run lint:layers` runs both greps. The cadence, scheduler, and alerting modules follow the same rule even though they sit outside `services/`: `src/scheduler/tick.js` and `src/alerting/lifecycle.js` orchestrate exclusively through repository calls, never issuing SQL themselves.

## Run it

Postgres 16, already running in Docker for this repo as `mern-postgres`. If it isn't running:

```bash
docker run -d --name mern-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres --restart unless-stopped postgres:16
```

Then:

```bash
cd sql-scheduler
npm install
cp .env.example .env
npm run migrate
npm run seed
npm run dev
```

API on `http://localhost:5005`. `npm run migrate` creates the `scheduler` database's schema, but the database itself must exist first — `docker exec mern-postgres createdb -U postgres scheduler` if it does not.

With the dev server running, two background loops run on their own intervals (`TICK_INTERVAL_MS`, default 5s; `ALERT_EVAL_INTERVAL_MS`, default 15s): the scheduler tick executes due schedules, and the alert evaluator checks every active rule against every schedule. `npm run seed` creates a schedule that fails most of its runs specifically so the `run_failure_rate` rule has something real to fire on within a couple of evaluation cycles — watch `GET /api/alerts` after starting the server against seeded data.

## Try it

```bash
curl -s -X POST http://localhost:5005/api/accounts \
  -H 'Content-Type: application/json' -d '{"name":"Acme","timezone":"Europe/Paris"}'

curl -s -X POST http://localhost:5005/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{"accountId":1,"name":"daily-digest","cadence":"daily at 09:00","timezone":"Europe/Paris","catchupPolicy":"skip"}'

curl -s http://localhost:5005/api/schedules
curl -s http://localhost:5005/api/runs
curl -s http://localhost:5005/api/alerts
curl -s -X POST http://localhost:5005/api/alerts/1/resolve
curl -s http://localhost:5005/api/notifications
```

## Test

```bash
npm test        # bootstraps and truncates its own scheduler_test database on every run
npm run test:ci # same, plus JUnit XML in test-results/
```

51 tests. They need a reachable Postgres — the same `mern-postgres` container, a separate `scheduler_test` database created automatically on first run.

## Topics and their READMEs

| Topic | Where |
|---|---|
| Timezone arithmetic: instants vs. wall-clock times vs. durations, the two DST anomalies, why cron has no timezone story | [src/cadence](src/cadence/README.md) |
| The tick loop: lock-vs-constraint exactly-once, catch-up policies, drift, deterministic jitter, and the handoff to `sql-jobs` | [src/scheduler](src/scheduler/README.md) |
| Alerting: symptoms vs. causes, dedup, hysteresis, cooldown, and the dead-man-switch trap | [src/alerting](src/alerting/README.md) |

## House rules

Same constraints as the rest of this repo, adapted to scheduling:

- A closed dependency list: `pg`, `dotenv`, `express`, `express-async-errors`, `cors`, plus `chai`/`chai-http`/`mocha`/`mocha-junit-reporter`/`mocha-multi-reporters`/`cross-env` for testing. **No cron library, no date library, no scheduling library** — every timezone computation in `src/cadence/` is hand-rolled on `Intl.DateTimeFormat`.
- Parameterised queries only; no SQL outside `repositories/`.
- No comments in source or tests. No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert.
- ESM, `.js` extensions on relative imports.
- All times `TIMESTAMPTZ`; every "is this due" comparison happens inside a query against Postgres's own `now()`.
