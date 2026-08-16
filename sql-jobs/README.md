# sql-jobs

A Postgres-backed async job queue. Originally briefed as `sql-scheduler` — a queue, a scheduler, and an alerting layer together, on a scheduled-content-publishing domain — the scope was narrowed mid-build to the queue alone; a scheduler (recurring cadences, timezone/DST arithmetic, catch-up policy) and an alerting layer (flap suppression, cooldowns, on-call routing) are related but separate problems, left for another app. See [`docs/plan.md`](docs/plan.md) for the original plan and its scope note.

The domain here is deliberately small: accounts send messages, and a queue delivers them.

## The domain

```
accounts   (id, name, created_at)
messages   (id, account_id, recipient, body, status, sent_at, created_at)
jobs       (id, kind, payload, run_at, priority, status, attempts, max_attempts,
            locked_at, locked_by, lease_expires_at, last_error, created_at, updated_at)
```

`POST /api/messages` writes the `messages` row and enqueues a `send_message` job in the same transaction. A worker claims due `jobs` rows, runs the handler registered for that `kind`, and records success, failure-with-retry, or dead-letter — see [`src/queue/README.md`](src/queue/README.md) for the whole mechanism: the fenced lease, the reaper, backoff and jitter, per-account fairness, and graceful shutdown.

## Layering

`routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own every SQL statement — no SQL outside `repositories/` (`migrations/` is the documented DDL exception), no `req`/`res` in services or repositories. `npm run lint:layers` runs both checks.

## Run it

Postgres 16, already running in Docker for this repo as `mern-postgres`. If it isn't running:

```bash
docker run -d --name mern-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres --restart unless-stopped postgres:16
```

Then:

```bash
cd sql-jobs
npm install
cp .env.example .env
docker exec mern-postgres createdb -U postgres jobs
npm run migrate
npm run seed
npm run dev
```

API and worker on `http://localhost:5004` (5000 shop, 5001 tickets, 5002 ledger, 5003 movies). `npm run dev` starts the HTTP server, the worker loop, and the lease reaper all in one process (`src/index.js`); there is no separate worker process to start.

`npm run seed` needs something listening for deliveries — the seeded `send_message` jobs will retry against a closed connection otherwise. [`src/queue/README.md`](src/queue/README.md)'s Try it section ships a two-line fake upstream.

## Test

```bash
npm test        # bootstraps and truncates its own jobs_test database on every run
npm run test:ci # same, plus JUnit XML in test-results/
```

28 tests. They need a reachable Postgres — the same `mern-postgres` container, a separate `jobs_test` database created automatically on first run.

## Topics and their READMEs

| Topic | Where |
|---|---|
| Job queue: fenced leases, the reaper, backoff/jitter, dead-lettering, fairness | [src/queue](src/queue/README.md) |

## House rules

Same constraints as the rest of this repo, adapted to a queue:

- A closed dependency list: `pg`, `dotenv`, `express`, `express-async-errors`, `cors`, plus `chai`/`chai-http`/`mocha`/`mocha-junit-reporter`/`mocha-multi-reporters`/`cross-env` for testing. No cron library, no queue library, no date library — `src/migrations/runner.js` and every mechanism in `src/queue/` are hand-rolled on purpose.
- Parameterised queries only.
- No comments in source or tests. No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert.
- ESM, `.js` extensions on relative imports.
