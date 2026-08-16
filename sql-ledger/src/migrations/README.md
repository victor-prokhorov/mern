# Migrations: a hand-rolled runner, and zero-downtime expand-contract

## What this is

Two things live here because they are really one topic. First, a migration runner with no library behind it: numbered `.sql` files, a `schema_migrations` bookkeeping table, and a Postgres advisory lock so two instances starting at once cannot both try to apply the same migration. Second, a worked example of the only way to change a live schema without downtime — expand, dual-write, backfill, verify, enforce, contract — applied to one real change this app needs: turning `accounts.balance_minor` from a value summed on every read into a value stored and kept in sync on every write.

## How it works here

**The runner.** `migrate(pool, { migrationsDir })` (`src/migrations/runner.js:74-96`) checks out one client, acquires the advisory lock (`acquireAdvisoryLock`, `src/migrations/runner.js:25-31`), creates `schema_migrations` if it does not exist (`src/migrations/runner.js:33-37`), reads which versions are already recorded (`src/migrations/runner.js:39-42`), and applies every `NNN_name.sql` file not yet in that table, in filename order, each inside its own `BEGIN`/`COMMIT` (`applyTransactional`, `src/migrations/runner.js:44-54`) — if the SQL throws, that one migration's transaction rolls back and the loop stops, but nothing already committed is undone. The lock is released in a nested `finally` (`src/migrations/runner.js:90-92`), itself inside an outer `finally` that always releases the client (`:93-95`) even if the unlock query itself throws. `npm run migrate` and `npm run migrate:status` (`src/migrations/cli.js`) are the two entry points; `status()` (`src/migrations/runner.js:98-107`) is read-only and does not take the lock, since there is nothing to serialize.

Acquiring the lock is **not** a single blocking `pg_advisory_lock` call, and that is not a stylistic choice — an earlier version of this runner did exactly that, and it deadlocked for real (see the next paragraph). Instead, `acquireAdvisoryLock` polls `pg_try_advisory_lock` — which returns immediately, true or false, rather than blocking — in a loop with a plain `setTimeout` sleep between attempts (`LOCK_RETRY_MS`, `src/migrations/runner.js:7,21-23`). Between attempts, the waiting session has no query in flight and no open transaction at all, which is the property the fix actually depends on.

One migration filename convention matters beyond the numbering: a file ending in `.concurrent.sql` is applied by `applyConcurrent` (`src/migrations/runner.js:68-72`) — no `BEGIN`/`COMMIT` around it at all — because `CREATE INDEX CONCURRENTLY` is a command Postgres refuses to run inside an explicit transaction block. `006_transfers_created_at_id_index.concurrent.sql` is the one example of this in the app, building the composite index the keyset-pagination query needs (see `src/pagination/README.md`) without taking a lock that would block writes to `transfers` while it builds. Before running the statement, `applyConcurrent` also calls `repairInvalidIndex` (`src/migrations/runner.js:56-66`), which checks `pg_index.indisvalid` for the migration's target index and, if a previous build was left `INVALID` (interrupted partway — see the core concepts below), drops it first so the retry can actually rebuild it. Without this, `CREATE INDEX CONCURRENTLY IF NOT EXISTS` would see the (invalid) index already exists and silently do nothing, forever.

**Expand-contract, six steps, two of them are files:**

1. **Expand** — `004_accounts_add_balance_minor.sql`: `ALTER TABLE accounts ADD COLUMN balance_minor bigint NULL`. Nullable, no default. The reason is not the one usually given, and the usual one is out of date: since Postgres 11, adding a column with a **non-volatile** default is metadata-only — the manual says the default "is evaluated at the time of the statement and the result stored in the table's metadata... In neither case is a rewrite of the table required." So `ADD COLUMN balance_minor bigint NOT NULL DEFAULT 0` would not rewrite this table on the Postgres 16 this app runs. It is still wrong here, for a different and better reason: **there is no constant that is the correct value.** Each account's balance is its own `SUM(entries.amount_minor)`, so any constant default would write a value that is wrong for every account with history, and `NOT NULL` would then be asserting something false the moment the column existed. Nullable-no-default says exactly the true thing — "this value is not known yet for these rows" — which is what makes the backfill in step 3 well-defined and resumable. The rewrite hazard is real, just narrower than the folklore: a **volatile** default (`clock_timestamp()`), a stored generated column, an identity column, or a domain type with constraints all still rewrite the whole table and its indexes.
2. **Dual-write** — no migration file; a code change. `services/transfers.js:38-39` calls `accountsRepo.adjustBalance` (`src/repositories/accounts.js:22-24`) for both accounts in the *same* transaction as the entries, so from the moment this code deploys, every new transfer keeps `balance_minor` and the summed `entries` in exact agreement, while every row written before this deploy still has `balance_minor = NULL`.
3. **Backfill** — `backfillBatch`/`backfillBalances` (`src/migrations/backfill.js:8-21`): one `UPDATE` per call, bounded by `WHERE balance_minor IS NULL ... LIMIT $1`, looped until a batch touches zero rows. Never one statement over the whole table — a single unbounded `UPDATE accounts SET balance_minor = (...)` would hold its row locks and its place in the transaction log for as long as the whole table takes to rewrite, which is exactly the long-running-transaction problem the batching avoids. Resumable is a direct consequence of the predicate, not a separate mechanism: interrupt the loop after any batch and re-run it, and it just continues where the `IS NULL` rows still are, because there is no separate "how far did we get" checkpoint to lose — the checkpoint *is* the data.
4. **Read new, verify old** — `verifyBalances` (`src/migrations/verify.js:12-19`): one query joining `accounts` to a `SUM(entries.amount_minor)` per account and returning only the rows where the two disagree (`IS DISTINCT FROM`, which — unlike `!=` — correctly treats `NULL` as distinct from any number rather than making the whole comparison `NULL`). This step only ever exists as a standalone batch script here, never wired into the request path itself — `GET /api/accounts/:id/balance` reads the stored value directly (step 6 already happened in this codebase's final state; see below). In a real rollout, this step runs *continuously* against live traffic during the overlap window, logging a discrepancy metric for anything it returns, while requests keep being served from the derived value until the operator is confident enough to cut over. That continuous, in-the-request-path version is asserted by test (deliberately corrupt a stored balance, assert `verifyBalances` catches it), not demonstrated as a running dual-read path, because this app's request path has already moved past this step.
5. **Enforce** — two migration files, deliberately not one: `005_accounts_enforce_balance_not_null.sql` runs `ADD CONSTRAINT ... CHECK (balance_minor IS NOT NULL) NOT VALID`, and `009_validate_balance_minor_not_null.sql` runs the `VALIDATE CONSTRAINT`. The first statement only checks *new and future* rows and returns immediately; the second scans existing rows to confirm they already comply, but takes only a `SHARE UPDATE EXCLUSIVE` lock rather than the `ACCESS EXCLUSIVE` a plain `ALTER COLUMN ... SET NOT NULL` would need — reads and writes continue against the table while it validates. The two-file split is load-bearing, not bookkeeping tidiness: `applyTransactional` wraps each file in a single `BEGIN`/`COMMIT`, and locks are only released at transaction end, so putting both statements in one file would hold `ADD CONSTRAINT`'s `ACCESS EXCLUSIVE` lock through the entire validation scan — blocking every read and write for exactly the duration the `NOT VALID`/`VALIDATE` pattern exists to keep the table available. The split only delivers its lock downgrade if the two statements commit in separate transactions, which under this runner means separate files (`test/migrations.test.js` asserts they stay separate). That the `VALIDATE` file is numbered `009` rather than adjacent to `005` is harmless — nothing between them writes `accounts` rows, and validating later only lengthens the window where the constraint is enforced-but-unvalidated, never weakens it.

   This app stops there, with a validated `CHECK` and no `NOT NULL` on the column itself. That is a real difference — a `CHECK` constraint and a genuine `NOT NULL` are not interchangeable to the planner, which can use a true `NOT NULL` to eliminate null-handling branches — and on Postgres 12 and later the last step is nearly free: `SET NOT NULL` will skip its table scan entirely when an already-valid constraint proves no nulls exist, which is exactly what the `CHECK` validated one statement earlier. So the complete, no-downtime recipe is three statements, not two: `ADD CONSTRAINT ... NOT VALID`, `VALIDATE CONSTRAINT`, then `SET NOT NULL`. On Postgres 11 and earlier the third statement scans the table under `ACCESS EXCLUSIVE` and the `CHECK` is where you stop; on 12+ there is no reason not to finish.
6. **Contract** — no migration file; a code change. `services/accounts.js`'s `getBalance` reads `getStoredBalance` (`src/repositories/accounts.js:26-29`) instead of `computeDerivedBalance`. The derived computation is not deleted — it is still what `verifyBalances` uses to check the stored copy — but the request path no longer touches it.

Every one of the six steps above is independently deployable, and that independence is the entire point: at any moment during a real rollout, some instances are running old code and some are running new code, against one schema, and every step has to make sense under that overlap. Step 1 has to be safe for *old* code that has never heard of `balance_minor` (it is — the column is nullable, old code just never touches it). Step 2 has to be safe to deploy before step 3 has backfilled anything (it is — dual-write only ever adds to a `NULL`, it doesn't need existing rows to already have a value). Step 5 has to wait until step 3 is fully finished, or `VALIDATE CONSTRAINT` fails outright on the first still-`NULL` row it finds — but it also, less obviously, has to wait until step 2 (dual-write) is fully rolled out to every instance first: if even one old instance without dual-write is still taking writes, it inserts entries without touching `balance_minor`, and the moment that row lands, `VALIDATE CONSTRAINT` (or any check against it afterward) fails on a row created *after* the backfill ran. "Backfill is finished" and "every writer already dual-writes" are two separate facts, and enforce is only safe once both are true.

## The core concepts

- **Migrations must be backwards-compatible with the currently deployed code, because old and new code run at the same time during any rollout.** A schema change is not "atomic with" a code deploy — Kubernetes rolling updates, blue-green deploys, or just two processes restarting at slightly different times all guarantee a window where some fraction of instances are running the old binary against the new schema, or the new binary against the old schema. Expand-contract exists entirely to make every individual step safe for that window, rather than trying to make the window disappear (it can't, in any system with more than one running instance).
- **Locking: `ACCESS EXCLUSIVE` versus `NOT VALID` + `VALIDATE`.** Postgres's own lock table (see Further reading) lists `ACCESS EXCLUSIVE` as the mode that conflicts with everything, including plain reads — it's what a bare `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT ...` or `ALTER COLUMN ... SET NOT NULL` takes while it validates the whole table. `ADD CONSTRAINT ... NOT VALID` takes that same strong lock but only for long enough to update catalog metadata — no table scan — and the follow-up `VALIDATE CONSTRAINT` takes the much weaker `SHARE UPDATE EXCLUSIVE`, which blocks other DDL and `VACUUM` but not ordinary reads or writes. Splitting one blocking operation into two statements with different lock strengths is the general trick step 5 relies on.
- **Why adding an index needs `CONCURRENTLY`.** A plain `CREATE INDEX` takes a lock that blocks writes to the table for the whole build. `CREATE INDEX CONCURRENTLY` (migration `006`) trades that away for a slower build — it makes two full passes over the table in separate transactions specifically so it never has to hold a single lock across the whole operation — and accepts a real failure mode in exchange: if it's interrupted, an `INVALID` index can be left behind that still costs write overhead but is never used for reads, and has to be dropped and rebuilt by hand — which `repairInvalidIndex` (above) does automatically the next time `migrate()` runs.
- **A blocking advisory lock and `CREATE INDEX CONCURRENTLY` can deadlock each other — this actually happened.** `pg_advisory_lock` blocks *inside a single query*; from Postgres's point of view, a session parked in that call still has an open virtual transaction, because the query hasn't returned yet. `CREATE INDEX CONCURRENTLY` has to wait for every such open transaction to end before it can validate the new index. Put those two together and you get a real cycle: session A runs the `CONCURRENTLY` migration and waits for session B's virtual transaction to end; session B is blocked inside `pg_advisory_lock`, waiting for session A to release it. Neither can proceed, and Postgres's own deadlock detector kills one with `error: deadlock detected (40P01)` — reproduced directly against this app's real migrations directory, two concurrent `migrate()` calls, freshly created database, no code changes needed to trigger it. Two pods both running `npm run migrate` on deploy — the exact scenario the lock exists to make safe — would crash. The fix is `pg_try_advisory_lock` polled in a loop instead of one blocking call (see above): between poll attempts the waiting session is not running any query and holds no transaction at all, so it never appears in `CREATE INDEX CONCURRENTLY`'s wait list in the first place.
- **Batched backfills and long-running transactions.** A backfill that runs as one transaction is a long-running transaction, and Postgres cannot vacuum away dead row versions newer than the oldest transaction still running — a long backfill can bloat, unrelated to `accounts` specifically, every table being concurrently modified while it's in flight. Batching each `UPDATE` into its own implicit transaction (`backfillBatch`, `src/migrations/backfill.js:8-11`, called repeatedly by `backfillBalances`) bounds every individual transaction's lifetime to one small batch, no matter how large the table is.
- **Rollback strategy, and the one irreversible step.** Steps 1-5 all have a clean way back: drop the constraint, stop the backfill, stop dual-writing, drop the column. Step 6 (contract) is reversible too, as long as the column hasn't been dropped — reverting the code to read the derived value again costs nothing. The only genuinely irreversible step in this whole sequence is dropping `balance_minor` itself, which this app never does (see What this toy skips) — once a column's data is gone, "roll back the migration" no longer means "run the old code," it means "restore from backup."
- **The same pattern in Mongo, and why the absence of DDL doesn't remove the problem.** Adding a field to a Mongo collection needs no `ALTER TABLE` at all — every existing document just doesn't have the field, and the driver returns `undefined` for it. That looks like it solves the "no `ACCESS EXCLUSIVE` lock" problem for free, but the actual hard parts of expand-contract were never about the `ALTER TABLE` syntax: dual-write, backfill, verify, and the "can old and new code both function against the current shape" question are exactly as necessary in Mongo, and there is no `VALIDATE CONSTRAINT` equivalent to lean on for the enforce step — "every document has this field with the right type" is something your application has to guarantee itself (or check with a `$jsonSchema` validator added after the fact), because the database will not stop you from inserting a document without it. Mongo hides the *migration statement*; it does not remove the *migration problem*.

## Standard practice

- Never ship `ADD COLUMN ... NOT NULL DEFAULT x` on a table anyone can write to concurrently — expand nullable, backfill, then enforce.
- Prefer `ADD CONSTRAINT ... NOT VALID` + `VALIDATE CONSTRAINT` over a lock-everything `SET NOT NULL` whenever the table is live.
- Always build a new index with `CONCURRENTLY` outside of a migration's own transaction wrapper.
- Batch backfills with a bounded `LIMIT` and a loop, never one `UPDATE` over an entire table.
- Guard concurrent migration runners with a database-level lock (advisory lock, or an equivalent), not an application-level assumption that only one instance will ever start at a time.
- Treat every migration as having to be correct against both the previous and the next version of the application code, because both will run against it at some point.

## What this toy skips

- No down-migrations. This runner only ever applies forward; reverting a step means writing and applying a new forward migration (e.g. `DROP CONSTRAINT`), never "undoing" the numbered file.
- No column is ever dropped, so the one genuinely irreversible move in the sequence is never exercised. The reason is specific rather than squeamish: the thing a real contract step would drop is the *old* representation, and here the old representation is `entries` itself — which is the ledger, and stays the system of record forever. `verifyBalances` still reads it, and that is the point. So this app demonstrates five and a half of the six steps; a change where the old column really does become dead weight would end with `DROP COLUMN`, and that is the step you cannot walk back by redeploying old code.
- The `NOT NULL` is only a validated `CHECK`, never an actual `SET NOT NULL` on the column (see step 5). Cheap to finish on Postgres 12+ and deliberately left as the illustrative stopping point.
- No dry-run / plan-only mode — `migrate()` always applies; there is no equivalent of `terraform plan`.
- No per-migration checksum or drift detection (verifying a previously-applied file hasn't been edited on disk since).
- The advisory lock key (`src/migrations/runner.js:6`) is a single hardcoded constant shared by every table this runner will ever manage — fine for one app with one migrations directory, not a general-purpose multi-tenant migration tool.

## Try it

```bash
docker run -d --name mern-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres --restart unless-stopped postgres:16
cd sql-ledger
npm install
cp .env.example .env
npm run migrate:status
npm run migrate
npm run migrate:status
```

The first `migrate:status` prints every file unchecked, `migrate` applies them, and the second prints them all checked. Re-running `migrate` prints `nothing to apply` — the runner is idempotent because `schema_migrations` is the record, not the filesystem.

Now inspect the three things the six-step sequence actually left behind in the catalog. This is the useful part: each one is a fact about the database, not about this app's code.

```bash
docker exec mern-postgres psql -U postgres -d ledger -c \
  "SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'transfers_created_at_id_idx';"

docker exec mern-postgres psql -U postgres -d ledger -c \
  "SELECT conname, convalidated FROM pg_constraint WHERE conname = 'balance_minor_not_null';"

docker exec mern-postgres psql -U postgres -d ledger -c \
  "SELECT attname, attnotnull FROM pg_attribute WHERE attrelid='accounts'::regclass AND attname='balance_minor';"
```

```
           relname           | indisvalid
-----------------------------+------------
 transfers_created_at_id_idx | t

        conname         | convalidated
------------------------+--------------
 balance_minor_not_null | t

    attname    | attnotnull
---------------+------------
 balance_minor | f
```

Read those three together. `indisvalid = t` is the `CONCURRENTLY` build having completed rather than being interrupted — this is the exact column `repairInvalidIndex` checks, and an `f` here is the failure mode that would otherwise wedge the migration forever. `convalidated = t` means step 5's second file (migration `009`) finished its `VALIDATE`, so every existing row has been proven non-null. And `attnotnull = f` is the honest limit of where this app stops: the *column* is still nullable, the guarantee lives entirely in the `CHECK`. On Postgres 12+, `ALTER TABLE accounts ALTER COLUMN balance_minor SET NOT NULL` would flip that third one without a table scan, precisely because the second one is already `t`.

Finally, run the verification step against live data:

```bash
node --input-type=module -e '
import { pool } from "./src/db.js"
import { verifyBalances } from "./src/migrations/verify.js"
console.log(await verifyBalances(pool))
await pool.end()'
```

An empty array: every stored `balance_minor` matches its summed entries. Now break one on purpose and run it again:

```bash
docker exec mern-postgres psql -U postgres -d ledger -c \
  "UPDATE accounts SET balance_minor = balance_minor + 1 WHERE id = 3;"
```

```
[ { accountId: '3', stored: -501n, derived: -502n } ]
```

That is step 4 doing its job — and note it caught drift that no constraint could, because "the stored copy agrees with the derived one" is a relationship between two tables, not a property of a row. Put the cent back (`- 1`) when you are done.

## Further reading

- [Martin Fowler — Parallel Change](https://martinfowler.com/bliki/ParallelChange.html) — the expand-contract pattern under its other common name, applied generally to backward-incompatible interface changes (not only schemas); the three phases (expand, migrate callers, contract) map directly onto the six steps here.
- [PostgreSQL documentation — `CREATE INDEX`](https://www.postgresql.org/docs/current/sql-createindex.html) — the `CONCURRENTLY` option: two table scans in separate transactions, why it can't run inside a transaction block, and the `INVALID` index failure mode.
- [PostgreSQL documentation — `ALTER TABLE`](https://www.postgresql.org/docs/current/sql-altertable.html) — `ADD CONSTRAINT ... NOT VALID` followed by `VALIDATE CONSTRAINT` as two separate statements, with a worked foreign-key example.
- [PostgreSQL documentation — Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) — the lock-mode table (§13.3.1): which DDL commands take `ACCESS EXCLUSIVE` versus the weaker `SHARE UPDATE EXCLUSIVE` that `CREATE INDEX CONCURRENTLY` and `VALIDATE CONSTRAINT` use. §13.3.5 covers advisory locks, including the session-versus-transaction distinction that the `pg_try_advisory_lock` deadlock story above turns on.
- [Squawk — a linter for Postgres migrations](https://squawkhq.com/docs/) — the rule catalogue is the fastest way to audit a migration you did not write. Each rule names one unsafe pattern, the Postgres versions it applies to, and the safe rewrite, which is exactly the version-dependence that makes the `ADD COLUMN ... DEFAULT` folklore above so persistent.
- [strong_migrations](https://github.com/ankane/strong_migrations) — the same idea as a Rails gem rather than a linter, and worth reading even outside Ruby for its README: a plain-English list of dangerous migrations with the safe multi-step rewrite for each, including the `NOT NULL` sequence this app implements and the version boundaries where the advice changes.
- [PostgreSQL documentation — Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html) — why a long-running transaction is a problem for the *whole* database and not just the table it touches: dead row versions newer than the oldest running transaction cannot be reclaimed. This is the mechanism behind the batched-backfill argument above.
- [PostgreSQL documentation — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — worth pairing with the vacuum page, because "the oldest running transaction" is the same snapshot machinery that makes MVCC work; understanding one explains the other.

Elsewhere in this repo: [`../ledger/README.md`](../ledger/README.md) for why the stored/derived balance pair exists at all and the write-skew scenario that motivates locking a balance check; [`../pagination/README.md`](../pagination/README.md) for the query this migration's `CONCURRENTLY` index actually serves.
