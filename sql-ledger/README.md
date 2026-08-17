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

`routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own every SQL statement — no SQL outside `repositories/` (the numbered files under `migrations/` are the one documented exception; they *are* the DDL layer), no `req`/`res` in services or repositories. `npm run lint:layers` runs both greps and reports what it found (nothing, on this branch). Both are line-based regexes, not an AST check — they catch every shape found in review (`res.status(...)`, `res["status"]`, `res .status`, a bare trailing `return res`) but a sufficiently indirect reference (e.g. aliasing `res` to another name first) would still slip through.

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

API on `http://localhost:5002`, which does not collide with anything else in this repo (`mern-shop` is 5000, `mern-tickets` is 5001, `mern-movies` is 5003).

`.env.example` points `DATABASE_URL` at `postgres://postgres:postgres@127.0.0.1:5432/ledger` and ships `OUTBOX_TARGET_URL` empty. That is deliberate: with no target set, `src/index.js` never starts the relay's `setInterval` at all, so the app runs fine with nothing on the receiving end and outbox rows simply accumulate unpublished. Set it to enable delivery (see [`src/outbox/README.md`](src/outbox/README.md), which ships a fake target you can point it at).

`npm run migrate` creates the `ledger` database's schema but the database itself must exist first; `docker exec mern-postgres createdb -U postgres ledger` if it does not. Unlike the three Mongo apps, there is no `seed` script — the domain has no fixtures, and every guide's Try it section creates the rows it needs.

## Test

```bash
npm test        # bootstraps and truncates its own ledger_test database on every run
npm run test:ci # same, plus JUnit XML in test-results/
```

53 tests. They need a reachable Postgres — the same `mern-postgres` container, a separate `ledger_test` database created automatically on first run.

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
- Parameterised queries only. `test/ledger.test.js` proves a hostile `reference` value (`x'); DROP TABLE transfers; --`) is stored as plain data, not executed. The one unavoidable exception is `test/helpers.js:16`'s `` CREATE DATABASE "${dbName}" `` — Postgres has no way to parameterise a database name in DDL, and `dbName` here comes only from this app's own trusted `DATABASE_URL`, never from a request.
- No comments in source or tests. No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert.
- ESM, `.js` extensions on relative imports.
