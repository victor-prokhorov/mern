# sql-saga

A Postgres orchestrated saga. Its problem is the **multi-service transaction**: `POST /api/orders` must reserve inventory, charge payment, place the order, and schedule shipping — four steps standing in for four separate services with four separate databases, so no single `BEGIN`/`COMMIT` can span them. A saga runs them as a sequence of local transactions, classifies each step as compensatable, pivot, or retryable, gives each step — and each compensation — a retry budget with full-jitter backoff, and on failure before the pivot runs the compensations in reverse so the world ends consistent instead of half-ordered. The whole decision is persisted in a saga log, so a crashed coordinator resumes instead of stranding a half-finished order. See [`src/saga/README.md`](src/saga/README.md) for the whole mechanism.

## The domain

```
inventory     (sku, available, reserved)
reservations  (saga_id, sku, qty, released)
payments      (id, saga_id, amount_minor, status)
shipments     (id, saga_id, address, status)
orders        (id, sku, qty, amount_minor, address, status)
saga          (id, type, order_id, status, context)
saga_steps    (id, saga_id, position, name, kind, status, attempts, max_attempts, last_error)
```

The first four tables stand in for four services; each step commits in exactly one of them. `saga` and `saga_steps` are the orchestrator's durable log: step `kind` is the pivot taxonomy (`compensatable` / `pivot` / `retryable`), `status` tracks each step through done, compensated, or failed, and `UNIQUE (saga_id, ...)` constraints on `payments`, `shipments`, and `reservations` are what make every step idempotent under at-least-once execution.

## Layering

`routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own every SQL statement — no SQL outside `repositories/` (`migrations/` is the documented DDL exception), no `req`/`res` in services or repositories. `npm run lint:layers` runs both checks. The engine in `src/saga/` follows the same rule: `engine.js` and `steps.js` orchestrate exclusively through repository calls.

## Run it

Postgres 16, already running in Docker for this repo as `mern-postgres`. If it isn't running:

```bash
docker run -d --name mern-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres --restart unless-stopped postgres:16
```

Then:

```bash
cd sql-saga
npm install
cp .env.example .env
docker exec mern-postgres createdb -U postgres saga
npm run migrate
npm run seed
npm run dev
```

API on `http://localhost:5008` (5000 shop, 5001 tickets, 5002 ledger, 5003 movies, 5004 jobs, 5005 scheduler, 5006 cache, 5007 replica). `npm run seed` stocks two SKUs and runs two sagas end to end — one that completes and one that aborts on insufficient stock and compensates — so `GET /api/sagas/1` and `GET /api/sagas/2` show both terminal shapes immediately.

## Try it

```bash
curl -s -X POST http://localhost:5008/api/inventory \
  -H 'Content-Type: application/json' -d '{"sku":"WIDGET-9","available":3}'

curl -s -X POST http://localhost:5008/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"sku":"WIDGET-9","qty":2,"amountMinor":4999,"address":"1 Test Lane"}'

curl -s http://localhost:5008/api/sagas/<saga id>
curl -s http://localhost:5008/api/inventory/WIDGET-9
```

The saga response carries the saga row, every step with its attempts, and the order/payment/shipment rows the steps produced. Place a second order with `qty` larger than the remaining stock to watch a saga abort: the reserve step exhausts its retry budget and fails, the saga flips to `compensated`, and the order is never placed — it stays `pending` with no payment row.

## Config

`.env.example` covers `DATABASE_URL` and `PORT`, plus `SAGA_STEP_BASE_MS` and `SAGA_STEP_CAP_MS`, which mirror the retry backoff's base and cap. Note the running app reads only `DATABASE_URL` and `PORT`; the backoff numbers are the defaults baked into `src/saga/backoff.js` (base 200ms, cap 30s), overridable per `runSaga` call rather than via the environment.

## Test

```bash
npm test        # bootstraps and truncates its own saga_test database on every run
npm run test:ci # same, plus JUnit XML in test-results/
```

23 tests. They need a reachable Postgres — the same `mern-postgres` container, a separate `saga_test` database created automatically on first run. Backoff sleeps are injected as no-ops in the tests, so retry-budget and compensation paths run instantly and deterministically.

## Topics and their READMEs

| Topic | Where |
|---|---|
| Sagas: compensation, the pivot taxonomy, retry budgets, idempotent steps, orchestration vs choreography | [src/saga](src/saga/README.md) |

## House rules

Same constraints as the rest of this repo, adapted to a saga:

- A closed dependency list: `pg`, `dotenv`, `express`, `express-async-errors`, `cors`, plus `chai`/`chai-http`/`mocha`/`mocha-junit-reporter`/`mocha-multi-reporters`/`cross-env` for testing. No workflow engine, no Temporal, no state-machine library — the engine, the step registry, and the backoff are hand-rolled on purpose.
- Parameterised queries only; no SQL outside `repositories/`.
- No comments in source or tests. No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert.
- ESM, `.js` extensions on relative imports.
