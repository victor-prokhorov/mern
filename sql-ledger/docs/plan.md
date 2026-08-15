# Plan C — sql-ledger: a Postgres app for outbox, migrations and keyset pagination

A new app, `sql-ledger/`, at the repo root beside `mern-shop`, `mern-tickets` and `mern-movies`. Postgres rather than Mongo, because all three of its topics are dishonest on a schemaless store: an outbox needs a real transaction spanning two tables, expand-contract needs real DDL, and keyset pagination is clearest with tuple comparison.

Copy this file to `sql-ledger/docs/plan.md` in your first commit.

**Branch:** `feat/sql-ledger`. Commit per task, TDD red then green with the real failing output in each red commit body. Do not open a PR.

## The domain

A double-entry ledger. Small, and it forces the constraints to matter.

```
accounts   (id, name, currency, created_at)
entries    (id, transfer_id, account_id, amount_minor, created_at)   -- amount is signed
transfers  (id, reference, status, created_at)
outbox     (id, aggregate, aggregate_id, type, payload, created_at, published_at, attempts, last_error)
```

Rules: a transfer writes exactly two entries whose amounts sum to zero, in one transaction. Money is `BIGINT` minor units — never floating point, and the README says why. Balances are derived by summing entries, not stored, until the migration task changes that deliberately.

## Global constraints

- Dependencies for this app, and nothing else: `pg`, `dotenv`, `express`, `express-async-errors`, `cors`, `chai`, `chai-http`, `mocha`, `mocha-junit-reporter`, `mocha-multi-reporters`, `cross-env`. No ORM, no query builder, no migration library — hand-rolling the migration runner is one of the three lessons. Node built-ins allowed.
- Postgres is already running: `postgres://postgres:postgres@127.0.0.1:5432/ledger`, container `mern-postgres` (postgres:16). Tests use a separate database `ledger_test`, created by the test bootstrap if absent and truncated between tests.
- **Parameterised queries only.** String-concatenated SQL is an automatic defect; add a test that a hostile `reference` value cannot inject.
- No comments in source or tests. No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert.
- ESM, `.js` extensions on relative imports.
- Same layering as the other apps: `routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own every SQL statement. No SQL outside `repositories/`, no `req`/`res` in services or repositories — enforce with the same two greps, adapted.
- Seven-section READMEs, every further-reading URL fetched before inclusion.

---

## Task 1 — Scaffold, schema and the migration runner

- `src/db.js`: a `pg` Pool, and a `withTransaction(fn)` helper that BEGINs, passes the client, COMMITs, and ROLLBACKs on throw. Every multi-statement write goes through it.
- **Migration runner** in `src/migrations/`: numbered SQL files, a `schema_migrations` table, applied in order inside a transaction each, guarded by `pg_advisory_lock` so two instances starting simultaneously cannot both apply. `npm run migrate` and `npm run migrate:status`.
- Migrations 001–003 create the tables above.
- Endpoints: `POST /api/accounts`, `POST /api/transfers` `{ reference, fromAccountId, toAccountId, amountMinor }`, `GET /api/accounts/:id/balance`, `GET /api/transfers` (paginated in Task 3).
- `reference` is unique — a natural idempotency key, and the README should point at `mern-shop/server/src/idempotency/README.md` for the general treatment.

**Tests:** a transfer writes exactly two entries summing to zero; a failed transfer leaves nothing behind (assert inside a rolled-back transaction); a duplicate reference is rejected; balance equals the sum of entries; the advisory lock serialises two concurrent migration runs; migrations are idempotent when re-run; SQL injection attempt via `reference` is stored as data, not executed.

**README** — `src/migrations/README.md` covers the runner and Task 2's strategy together (see below). A short `src/ledger/README.md` covers the domain: double-entry, minor units, derived versus stored balances, and why `SERIALIZABLE` or explicit locking matters if you ever add a balance check — demonstrate a write-skew scenario in prose.

---

## Task 2 — Zero-downtime migration, expand and contract

The scenario: balances are computed by summing entries, which is correct but slow. You want a stored `balance_minor` on `accounts` — while the app keeps serving.

Implement it as the six real steps, each its own migration and each individually deployable:

1. **Expand** — add `balance_minor BIGINT NULL`. Nullable is what makes it safe; a `NOT NULL` column with a default rewrites the table and takes a lock.
2. **Dual-write** — new writes update both representations, inside the same transaction as the entries.
3. **Backfill** — batched, bounded, resumable, with a `WHERE balance_minor IS NULL` predicate and a batch size, never one statement over the whole table.
4. **Read new, verify old** — read the stored value, recompute the derived one, log a discrepancy metric.
5. **Enforce** — add the `NOT NULL` constraint using `NOT VALID` then `VALIDATE CONSTRAINT`, which does not hold a write lock over the whole table.
6. **Contract** — stop the dual-read.

**Tests:** the backfill is resumable (interrupt it and re-run, get the same result); dual-write keeps both representations equal under concurrent transfers; the verify step detects a deliberately corrupted stored balance; each migration applies cleanly against a database at the previous step; running the full sequence twice is a no-op.

**README** — `src/migrations/README.md`. Concepts: expand-contract and why every step is separately deployable; that migrations must be **backwards-compatible with the currently deployed code**, because old and new run simultaneously during a rollout; locking (`ACCESS EXCLUSIVE` versus `NOT VALID` + `VALIDATE`); why adding an index needs `CONCURRENTLY`; batched backfills and long-running transactions; rollback strategy, and that dropping a column is the only irreversible step; the same pattern in Mongo, where the absence of DDL hides the problem rather than removing it.

---

## Task 3 — Keyset pagination

`GET /api/transfers?limit=&cursor=`.

- Order by `(created_at DESC, id DESC)`; the cursor is base64 of that tuple; the predicate is a **row comparison** `(created_at, id) < ($1, $2)`, not `OFFSET`.
- The response carries `nextCursor` and no total count — explain in the README why a count is expensive and usually a lie under concurrent writes.
- Cursors are opaque and validated; a malformed cursor is 400, never a crash or an unfiltered query.

**Tests, and this is the important one:** a test that inserts rows *between* page fetches and proves **offset pagination skips and duplicates rows while keyset does not**. Implement a small offset-based endpoint solely so the test can demonstrate the failure, and mark it clearly as a demonstration. Also: page boundaries are exact with ties on `created_at`; the last page has no `nextCursor`; a malformed cursor is 400; `limit` is clamped.

**README** — `src/pagination/README.md`. Concepts: offset versus keyset with the skip/duplicate failure shown; why the tuple comparison needs a matching composite index and what the planner does without it; stable sort keys and ties; opaque cursors and why they should be signed or validated; total counts and their cost; deep pagination as a denial-of-service surface; when offset is genuinely fine.

---

---

## Task 4 — Transactional outbox

The topic this app exists for. Two READMEs in this repo already promise it.

**The problem:** `POST /api/transfers` must both write the transfer and tell the outside world about it. A database write plus an HTTP call is not atomic. Write first and the notification can be lost; notify first and you can announce a transfer that never committed. No amount of retry logic fixes it, because the failure is between two systems.

**Mechanics**

- The transfer, its two entries, **and** the outbox row are inserted in **one transaction**. If the transfer rolls back, so does the intent to publish. That is the whole trick, and the README must make it unmissable.
- A **relay** (`src/outbox/relay.js`) polls for unpublished rows and delivers them. Claim with:

  ```sql
  SELECT … FROM outbox WHERE published_at IS NULL AND attempts < $max
  ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $batch
  ```

  `SKIP LOCKED` is what lets several relay workers run without stepping on each other or serialising behind one slow row. The README explains it — it is the single most useful Postgres feature most engineers have never used.
- Delivery target is an HTTP endpoint from `OUTBOX_TARGET_URL`, called with global `fetch` and `AbortSignal.timeout`. Failure increments `attempts` and records `last_error`; retry uses **exponential backoff with full jitter**, computed from `attempts`.
- After `maxAttempts`, the row is parked as dead-lettered (`status` or a `dead_lettered_at` column) and must never block later rows.
- Delivery is **at-least-once**: the relay can crash after delivering and before marking published, so the same message goes twice. Every message carries a stable id the consumer can dedupe on, and the README says plainly that the consumer's idempotency — not the relay — is what makes the system correct. Cross-reference `mern-shop/server/src/idempotency/README.md`.
- The relay is a function driven by tests, not a `setInterval` that only runs in production. Wire an interval in `index.js` only when a target URL is configured.

**Tests** (fake upstream is a real `node:http` server on an ephemeral port):

- a committed transfer leaves exactly one unpublished outbox row;
- **a rolled-back transfer leaves none** — the test that proves the pattern;
- the relay delivers and marks published, and a second run delivers nothing;
- a failing upstream increments `attempts`, records the error, and leaves the row unpublished;
- backoff delays grow with attempts and are jittered (assert bounds, not equality);
- after `maxAttempts` the row is dead-lettered and a later healthy row still delivers;
- two relay workers running concurrently never deliver the same row twice (`SKIP LOCKED` proven with two overlapping claims);
- a crash between delivery and marking published results in a duplicate delivery — assert it happens, because pretending otherwise is the lie this pattern exists to expose.

**README** — `src/outbox/README.md`. Concepts: dual-write and why it cannot be made atomic; the outbox pattern; polling relay versus change-data-capture (Debezium, logical decoding) and the tradeoff; `FOR UPDATE SKIP LOCKED` and competing consumers; at-least-once and consumer idempotency; ordering, and that per-aggregate ordering is achievable while global ordering is expensive; poison messages and dead-letter queues; backoff with full jitter and why jitter matters; outbox growth and archival; the inbox pattern as the mirror image. Cross-reference the circuit breaker and hooks READMEs in mern-tickets, and the fan-out README in mern-movies.

## Also

- `sql-ledger/README.md`: what the app is, how to run Postgres in Docker, migrate, seed, test, and an index of its READMEs.
- Add the app and its three topics to the root `README.md` app table and topic table.

## Report

Write to `/private/tmp/claude-502/-Users-victor-p-mern/45166ac0-196d-4053-b8d5-e0370ad855fe/scratchpad/sql-ledger-report.md`: per task, what you built, TDD evidence, the full suite result, the two layering grep results, every link fetched, any concern. Reply with status, branch, commits, one-line test summary, concerns, report path — under 15 lines.
