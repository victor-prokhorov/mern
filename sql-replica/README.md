# sql-replica

A Postgres primary/replica simulation. Its problem is **read consistency under replication lag**: one logical primary takes every write, one or more logical replicas serve reads as of a lagging position, and the application has to route each read to the right place — strong reads to the primary, tolerant reads to a replica, read-your-writes via a sticky-primary window or a write-position token, monotonic reads via session pinning. There is exactly one physical Postgres here; "the replica is behind" is a visibility rule over an append-only change log, injectable lag, and an injectable clock, so every staleness claim in the tests is deterministic. See [`src/replication/README.md`](src/replication/README.md) for the whole mechanism and every place the simulation diverges from real WAL streaming.

## The domain

```
accounts       (id, name, created_at)
changes        (version, account_id, doc_key, body, written_at)
replica_state  (replica_name, applied_through, applied_at)
```

`changes` is the replication log: every document write appends a row with a globally monotonic `version` (a single Postgres sequence) and a `written_at` stamped from the injected clock. A replica's whole state is one number, `applied_through` — the highest version it has replayed — advanced by a tick to the newest change older than that replica's configured lag, and only ever forward. A document read "from the replica" is a query over `changes` capped at that position.

## Layering

`routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own every SQL statement — no SQL outside `repositories/` (`migrations/` is the documented DDL exception), no `req`/`res` in services or repositories. `npm run lint:layers` runs both checks. The routing machinery in `src/replication/` follows the same rule: `router.js` and `tick.js` orchestrate exclusively through repository calls.

## Run it

Postgres 16, already running in Docker for this repo as `mern-postgres`. If it isn't running:

```bash
docker run -d --name mern-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres --restart unless-stopped postgres:16
```

Then:

```bash
cd sql-replica
npm install
cp .env.example .env
docker exec mern-postgres createdb -U postgres replica
npm run migrate
npm run dev
```

API on `http://localhost:5007` (5000 shop, 5001 tickets, 5002 ledger, 5003 movies, 5004 jobs, 5005 scheduler, 5006 cache). There is no seed script; `POST /api/accounts` and `POST /api/documents` are the whole setup. `npm run dev` starts the HTTP server plus a background loop that ticks every replica each `TICK_MS`, so replicas catch up on their own — the [Try it](src/replication/README.md#try-it) walkthrough in the guide shows the stale read, the strong read, and the token-gated read against a live 5-second lag.

## Config

`.env.example` covers `DATABASE_URL` and `PORT`, plus three knobs: `REPLICA_LAG_MS` (how far behind the replica runs, default 5000), `STICKY_MS` (how long after a write a session's reads stay pinned to the primary, default 5000), and `TICK_MS` (the background replay interval, default 1000).

## Test

```bash
npm test        # bootstraps and truncates its own replica_test database on every run
npm run test:ci # same, plus JUnit XML in test-results/
```

17 tests. They need a reachable Postgres — the same `mern-postgres` container, a separate `replica_test` database created automatically on first run. The clock and lag are frozen in the tests, so the staleness boundary, the monotonic-reads regression across two replicas, and the pin that fixes it are exact assertions, not races.

## Topics and their READMEs

| Topic | Where |
|---|---|
| Replication lag, read-after-write consistency, sticky windows, write-position tokens, monotonic reads, PACELC | [src/replication](src/replication/README.md) |

## House rules

Same constraints as the rest of this repo, adapted to replication:

- A closed dependency list: `pg`, `dotenv`, `express`, `express-async-errors`, `cors`, plus `chai`/`chai-http`/`mocha`/`mocha-junit-reporter`/`mocha-multi-reporters`/`cross-env` for testing. No replication library, no second Postgres process — the log, the tick, and the router are hand-rolled on purpose.
- Parameterised queries only; no SQL outside `repositories/`.
- No comments in source or tests. No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert.
- ESM, `.js` extensions on relative imports.
