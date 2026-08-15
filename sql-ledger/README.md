# sql-ledger

A Postgres-backed double-entry ledger. Where `mern-shop`, `mern-tickets`, and `mern-movies` are all Mongo, this app is Postgres on purpose: its three real topics — the transactional outbox, zero-downtime expand-contract migrations, and keyset pagination — are all dishonest on a schemaless store. An outbox needs a real transaction spanning two tables; expand-contract needs real DDL with real lock semantics; keyset pagination is clearest with a tuple (row-value) comparison. None of those exist the same way in Mongo.

## The domain

```
accounts   (id, name, currency, balance_minor, created_at)
transfers  (id, reference, status, created_at)
entries    (id, transfer_id, account_id, amount_minor, created_at)   -- signed
outbox     (id, aggregate, aggregate_id, type, payload, created_at, published_at, attempts, last_error, dead_lettered_at)
```

A transfer writes exactly two entries whose `amount_minor` sum to zero, dual-writes both accounts' `balance_minor`, and writes an outbox row — all four in one transaction. Money is `BIGINT` minor units everywhere, never a float.

## Layering

`routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own every SQL statement — no SQL outside `repositories/` (the numbered files under `migrations/` are the one documented exception; they *are* the DDL layer), no `req`/`res` in services or repositories. `npm run lint:layers` runs both greps and reports what it found (nothing, on this branch).

## Run it

Postgres 16, already running in Docker for this repo as `mern-postgres`. If it isn't running:

```bash
docker run -d --name mern-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres --restart unless-stopped postgres:16
```

Then:

```bash
cd sql-ledger
npm install
cp .env.example .env
npm run migrate
npm run dev
```

`.env.example` points `DATABASE_URL` at `postgres://postgres:postgres@127.0.0.1:5432/ledger`. Set `OUTBOX_TARGET_URL` to enable the relay's poll loop (see `src/outbox/README.md`).

## Test

```bash
npm test        # bootstraps and truncates its own ledger_test database on every run
npm run test:ci # same, plus JUnit XML in test-results/
```

26 tests. They need a reachable Postgres — the same `mern-postgres` container, a separate `ledger_test` database created automatically on first run.

## Topics and their READMEs

| Topic | Where |
|---|---|
| Domain: double-entry, minor units, derived vs. stored balance, write skew | [src/ledger](src/ledger/README.md) |
| Migration runner, and the six-step expand-contract migration | [src/migrations](src/migrations/README.md) |
| Keyset pagination vs. `OFFSET` | [src/pagination](src/pagination/README.md) |
| Transactional outbox and the relay worker | [src/outbox](src/outbox/README.md) |

## House rules

Same constraints as the rest of this repo, adapted to SQL:

- A closed dependency list: `pg`, `dotenv`, `express`, `express-async-errors`, `cors`, plus `chai`/`chai-http`/`mocha`/`mocha-junit-reporter`/`mocha-multi-reporters`/`cross-env` for testing. No ORM, no query builder, no migration library — the migration runner in `src/migrations/runner.js` is hand-rolled on purpose.
- Parameterised queries only. `test/ledger.test.js` proves a hostile `reference` value (`x'); DROP TABLE transfers; --`) is stored as plain data, not executed.
- No comments in source or tests. No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert.
- ESM, `.js` extensions on relative imports.
