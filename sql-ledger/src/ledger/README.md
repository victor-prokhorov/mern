# Ledger domain

## What this is

A minimal double-entry ledger: `accounts`, `transfers`, and `entries`. A transfer between two accounts writes exactly two entries whose `amount_minor` values sum to zero — one negative (the debit), one positive (the credit) — in a single transaction. There is no separate "debit" or "credit" table; the sign of `amount_minor` is the only thing that distinguishes them. This is the textbook shape of double-entry bookkeeping, and it is deliberately the smallest domain that makes the app's three real topics (outbox, migrations, pagination) matter: a transfer is exactly the kind of write that needs a real transaction spanning more than one table, which a schemaless store cannot make honest.

## How it works here

`POST /api/transfers` (`src/controllers/transfers.js:3-12`) adapts the request body and calls `services/transfers.js`'s `createTransfer` (`src/services/transfers.js:25-47`), which validates first (`assertValidTransferInput`, `src/services/transfers.js:18-23`: rejects a missing reference, non-integer account ids, transferring an account to itself, and a non-positive or unsafely-large `amountMinor`) and then runs everything inside `withTransaction` (`src/db.js:8-25`): insert the `transfers` row, insert the outbox row, insert the two `entries` rows (`-amountMinor` then `+amountMinor`), and dual-write both accounts' `balance_minor` (`src/repositories/accounts.js:22-24`) — all five statements, one transaction, one commit or one rollback.

Money is `BIGINT` minor units everywhere — `entries.amount_minor`, `accounts.balance_minor` — never a float and never a decimal column. A balance is either summed from `entries` (`computeDerivedBalance`, `src/repositories/accounts.js:14-20`, used by the migration's verify step) or read directly from the stored `accounts.balance_minor` column (`getStoredBalance`, `src/repositories/accounts.js:26-29`, what `GET /api/accounts/:id/balance` actually calls via `services/accounts.js`). Both must always agree — that agreement, and how it survives concurrent writers, is the entire subject of `src/migrations/README.md`.

`transfers.reference` is `UNIQUE` (`src/migrations/002_create_transfers_and_entries.sql`), which is what makes a transfer idempotent: submitting the same `reference` twice is rejected with 409 rather than double-spending (`src/services/transfers.js:43`, mapped from Postgres's `23505` unique-violation code). That is the same idea as `mern-shop/server/src/idempotency/README.md` — a natural key on the write itself, rather than a separate idempotency-key table — and worth reading there for the general treatment (a client-supplied key with its own expiry and response-replay semantics) versus the narrower case here (the ledger's own business key already happens to be a good idempotency key).

The "exactly two entries summing to zero" invariant is not only tested, it is **enforced by the database**, independently of this app's code: migration `008_entries_balance_constraint_trigger.sql` adds a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `entries` that sums `amount_minor` per `transfer_id` and raises if the total isn't zero. Deferred means the check runs once, at commit time, against the final state — not after every individual `INSERT` — so `createTransfer`'s own two sequential entry inserts (briefly unbalanced between them) never trip it, while a single stray `INSERT INTO entries` run directly against the database, bypassing this app entirely, does. `test/ledger.test.js` proves this by attempting exactly that kind of direct SQL tampering and asserting it's rejected.

## The core concepts

- **Double-entry means every transfer is self-balancing by construction.** Summing `amount_minor` over any single transfer's entries is always zero; summing over all entries for one account gives that account's balance without ever needing a running total column to be right — which is exactly why it is safe to *also* keep a running total (`balance_minor`) as a cache, as long as something can always re-derive and check it. That "something" is `verifyBalances` (`src/migrations/verify.js`).
- **Minor units are not a formatting choice, they are a correctness requirement.** `100.10 + 100.20` is not `200.30` in IEEE-754 double precision — it is `200.29999999999998`. A ledger that stores dollars as floats will eventually disagree with itself about whether a cent exists. Storing `10010` and `10020` as `BIGINT` and dividing by 100 only at the display layer means every arithmetic operation the database or the application performs is exact integer arithmetic, with no rounding step to get wrong.
- **Derived vs. stored balance is a caching problem with a correctness twist.** A derived balance (`SUM(entries.amount_minor)`) is always correct but gets slower as an account accumulates entries. A stored balance is fast but is now a second copy of the truth that can drift from the first — through a missed dual-write, a partial failure, or a bug. `src/migrations/README.md` covers the six-step migration that introduces the stored copy safely; this README only needs you to know that both exist and both must agree.
- **Why explicit locking (or `SERIALIZABLE`) would matter the moment you add a balance check — and why that's a lost update, not write skew.** This app does not enforce "balance must not go negative" — nothing here rejects an overdraft. The moment it did, a plain `UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2` running under the default `READ COMMITTED` isolation would not be enough to protect that invariant. Concretely: account A has balance 100 and a rule "balance must stay ≥ 0". Two concurrent transfers each debit A by 60: transaction 1 reads A's balance (100), computes 100 − 60 = 40 ≥ 0, and is about to write. Transaction 2, at the same moment, also reads A's balance (100, since transaction 1 hasn't committed), also computes 40 ≥ 0, and is about to write. Both checks passed because both read the *same* starting balance. Both commit. The real balance is now −20. This is a **lost update** (a read-modify-write race) — both transactions read and wrote the *same* row — not write skew, and it doesn't need `SERIALIZABLE`'s predicate locking to fix: a plain `SELECT ... FOR UPDATE` on account A's row before checking the balance is enough, because it forces the second transaction to block until the first commits or rolls back, so its balance check is no longer working from stale data.

  **Write skew is the harder, disjoint-row version of this same class of bug**, and it genuinely does need `SERIALIZABLE` (or locking every row the invariant touches, not just the one about to be written) — because the two transactions never write the same row, so no ordinary row lock ever puts them in conflict. Postgres's own documentation illustrates it with two doctors on call: a rule says at least one of Alice and Bob must always be on call. Alice checks "is Bob on call?" — yes — and takes herself off call, writing only her own row. Bob, concurrently, checks "is Alice on call?" — the snapshot he's reading from still shows yes, since Alice's transaction hasn't committed yet — and takes himself off call too, writing only *his* row. Both commit. Now nobody is on call, and neither transaction ever touched the row the other one wrote: `SELECT ... FOR UPDATE` on your own row does nothing here, since the conflict lives entirely in what each transaction *read*, not what either one *wrote*. Only `SERIALIZABLE` isolation (which uses predicate locking to detect exactly this) or locking every row the invariant depends on up front — defeating the point of having two independently-lockable doctors — catches it. Postgres's own documentation describes this class of anomaly directly under `SERIALIZABLE` isolation (see Further reading), including the "could not serialize access due to read/write dependencies among transactions" error a real implementation would hit.

- **Minor units are per currency, not universally two decimal places.** ISO 4217 assigns each currency a number of minor digits: most have two, JPY and KRW have zero, and KWD, BHD, JOD and a few others have three. `amount_minor` is therefore only meaningful *relative to* the account's `currency` column — 500 is five dollars, five hundred yen, or half a dinar. This app never divides, so it never gets the divisor wrong; the moment a display layer or a conversion appears, a hardcoded `/100` is a bug for a large minority of the world's currencies.
- **Entries are append-only by convention here, not by constraint.** Nothing in the schema stops an `UPDATE` or a `DELETE` on `entries`, and the accounting answer to a mistake is not to edit the entry — it is to post a compensating pair of entries that reverses it, leaving both the original and the correction in the record. That is why real ledgers are immutable: the audit question is "what happened and in what order", which an edited row cannot answer. What the constraint trigger *does* give you is that any such edit must still leave the transfer summing to zero, since it fires on `UPDATE` and `DELETE` as well as `INSERT` — so a tamper cannot quietly unbalance the books, only rewrite them in a balanced way. Compare [`../../../mern-tickets/server/src/tickets/README.md`](../../../mern-tickets/server/src/tickets/README.md), which makes the same convention-not-enforcement point about its audit log.

## Standard practice

- Model money as an integer count of the smallest unit the currency has (cents, pence, öre), never as a float and never relying on a language's default decimal type without being deliberate about it.
- Keep a natural, unique business key on any write that must not be repeated, rather than bolting on a separate idempotency mechanism when the domain already has one.
- Treat a cached/derived pair of values (here, stored vs. summed balance) as needing an explicit verification path, not just an initial backfill and hope.
- Reach for `SERIALIZABLE` or explicit row locking the moment an invariant spans more than one row read across a transaction boundary — `READ COMMITTED` alone does not protect it.
- Enforce a genuinely load-bearing invariant (like "these rows sum to zero") at the database level with a constraint, not only in application code — application code can be bypassed by a migration, a script, or a future author who doesn't know the rule exists; a deferred constraint trigger cannot.

## What this toy skips

- No overdraft/negative-balance protection, so the write-skew scenario above is illustrated in prose rather than reproduced as a bug in this codebase — there is no invariant here for two concurrent transfers to actually break.
- No multi-currency conversion. `accounts.currency` is stored per account but nothing here converts between currencies or rejects a transfer between two different-currency accounts.
- No reversal/void transfer type — a mis-posted transfer cannot be corrected with a compensating entry, only observed. `transfers.status` exists in the schema and is the natural place a real lifecycle would live (`pending`, `posted`, `reversed`), but `createTransfer` hardcodes `'completed'` (`src/services/transfers.js:29`) and nothing ever writes another value or reads the column for a decision. It is a dead field kept for shape, not a state machine — compare [`../../../mern-tickets/server/src/tickets/README.md`](../../../mern-tickets/server/src/tickets/README.md) for what one looks like when it is real.
- No immutability enforcement on `entries` — see the append-only note above. Nothing revokes `UPDATE`/`DELETE` at the grant level, and the trigger only checks that whatever you do leaves the transfer balanced.
- No per-currency minor-unit handling. `accounts.currency` is a free-text three-letter string with no lookup of its ISO 4217 minor-digit count, and nothing prevents a transfer between two accounts holding different currencies — which would silently treat one currency's minor units as another's.
- No `SERIALIZABLE` isolation or explicit locking is actually used anywhere in this codebase, because there is no invariant here that needs it yet.
- **The entries-sum-to-zero trigger has a blind spot: a transfer with *zero* entries.** `entries_balance_check` is a row-level trigger `AFTER INSERT OR UPDATE OR DELETE ON entries` — it only ever runs when a row in `entries` actually changes. A `transfers` row inserted with no matching `entries` at all (confirmed directly: `INSERT INTO transfers (reference, status) VALUES (...)` with nothing inserted into `entries` afterward commits with no error) never fires the trigger, because there is no row event for it to fire on. This is a pre-existing gap in the enforcement, not a regression — the invariant is enforced *given* at least one entries change, not made total over every possible transfers row. `createTransfer` never produces this shape (it always inserts exactly two entries in the same transaction as the transfer row), but nothing at the schema level stops a `transfers` row from existing alone.

## Try it

Requires the app running against the real `ledger` database (see the root `README.md` for Docker/migrate/start), not the test database.

```bash
curl -s -X POST http://localhost:5002/api/accounts -H 'Content-Type: application/json' -d '{"name":"alice","currency":"USD"}'
curl -s -X POST http://localhost:5002/api/accounts -H 'Content-Type: application/json' -d '{"name":"bob","currency":"USD"}'
```

Each returns the created row, including its `id`. Use those two ids below rather than assuming `1` and `2` — `accounts.id` is a `bigserial`, so it keeps climbing across re-runs and only starts at 1 on a genuinely fresh database.

```bash
curl -s -X POST http://localhost:5002/api/transfers -H 'Content-Type: application/json' \
  -d '{"reference":"demo-1","fromAccountId":<alice id>,"toAccountId":<bob id>,"amountMinor":500}'

curl -s http://localhost:5002/api/accounts/<alice id>/balance
curl -s http://localhost:5002/api/accounts/<bob id>/balance
```

`{"balanceMinor":"-500"}` and `{"balanceMinor":"500"}`. Two things to notice: the balance is a *string*, because `BIGINT` exceeds what a JSON number can carry safely and the `pg` driver hands it back as text rather than silently losing precision at 2^53; and it is 500, not 5.00, because the API speaks minor units end to end and formatting is the caller's job.

Now send the identical request again. That is the idempotency property, and it is the unique `reference` doing the work:

```bash
curl -s -w ' HTTP %{http_code}\n' -X POST http://localhost:5002/api/transfers -H 'Content-Type: application/json' \
  -d '{"reference":"demo-1","fromAccountId":<alice id>,"toAccountId":<bob id>,"amountMinor":500}'
```

`{"error":"reference already used"} HTTP 409`, and the balances are unchanged — the whole transaction rolled back, entries and outbox row included. Two more inputs the service refuses before it opens a transaction at all:

```bash
curl -s -w ' HTTP %{http_code}\n' -X POST http://localhost:5002/api/transfers -H 'Content-Type: application/json' \
  -d '{"reference":"demo-2","fromAccountId":<alice id>,"toAccountId":<alice id>,"amountMinor":500}'
curl -s -w ' HTTP %{http_code}\n' -X POST http://localhost:5002/api/transfers -H 'Content-Type: application/json' \
  -d '{"reference":"demo-3","fromAccountId":<alice id>,"toAccountId":999999,"amountMinor":500}'
```

`400 fromAccountId and toAccountId must differ`, then `400 fromAccountId or toAccountId does not exist` — the second one is not application validation, it is Postgres's foreign-key violation (`23503`) caught and translated in `src/services/transfers.js:44`.

Finally, watch the constraint trigger refuse an unbalanced write that never goes through this app at all. Insert a single entry against an existing transfer, straight into the database:

```bash
docker exec mern-postgres psql -U postgres -d ledger -c \
  "INSERT INTO entries (transfer_id, account_id, amount_minor) SELECT id, 1, 1 FROM transfers ORDER BY id DESC LIMIT 1;"
```

```
ERROR:  entries for transfer 102 do not sum to zero (got 1)
CONTEXT:  PL/pgSQL function check_transfer_balance() line 9 at RAISE
```

That is the point of enforcing the invariant in the schema rather than only in `createTransfer`: the rule survives a script, a migration, or a future author who does not know the rule exists. Note it fired at commit, not at the `INSERT` — the statement itself reports `INSERT 0 1` inside an explicit transaction and only the `COMMIT` fails, because the trigger is `DEFERRABLE INITIALLY DEFERRED`.

## Further reading

- [Martin Fowler, PoEAA — Money](https://martinfowler.com/eaaCatalog/money.html) — why money needs its own representation rather than a language's native numeric type; this app takes the narrower path (a plain `BIGINT` column plus a currency column) rather than a full `Money` value type, but the underlying reason — "the lack of a type causes problems, the most obvious surrounding currencies" — is the same one that rules out floats here.
- [David Goldberg, *What Every Computer Scientist Should Know About Floating-Point Arithmetic* (Computing Surveys, March 1991)](https://docs.oracle.com/cd/E19957-01/806-3568/ncg_goldberg.html) — the long answer to why `100.10 + 100.20` is not `200.30`. You do not need all of it; the "Rounding Error" section is enough to stop treating float money as a formatting problem rather than a representation one.
- [PostgreSQL documentation — Monetary Types](https://www.postgresql.org/docs/current/datatype-money.html) — read it for the two warnings, not for the type. Postgres's own `money` type is locale-sensitive (a dump loaded into a database with a different `lc_monetary` may not work) and the page states plainly that "floating point numbers should not be used to handle money due to the potential for rounding errors". Between locale-dependence and float conversion hazards, `BIGINT` minor units or `numeric` are what is left.
- [ISO 4217 currency codes and minor units (SIX, the maintenance agency)](https://www.six-group.com/en/products-services/financial-information/data-standards.html) — what "minor unit" actually means per currency, and why 100 is not a universal divisor: JPY has zero minor digits, most currencies have two, and a few (KWD, BHD, JOD) have three. A ledger that hardcodes `/100` at the display layer is wrong for a third of the world the day it adds a second currency.
- [TigerBeetle, Data modeling](https://docs.tigerbeetle.com/coding/data-modeling/) — the same integer-minor-unit decision made by a database built specifically for double-entry accounting: "map the smallest useful unit of the fractional currency to 1", with 128-bit integers rather than this app's 64. Also worth reading for how a serious ledger models a debit-balance versus a credit-balance account, which this toy collapses into a single signed `amount_minor`.
- [PostgreSQL documentation — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — the `SERIALIZABLE` section documents write skew directly, including the "could not serialize access due to read/write dependencies among transactions" error a real implementation of the balance-check scenario above would hit. Read §13.2.1 first, so you know what `READ COMMITTED` — the default this app runs under — does and does not promise.
- [Berenson, Bernstein, Gray, Melton, O'Neil and O'Neil, *A Critique of ANSI SQL Isolation Levels* (SIGMOD 1995)](https://arxiv.org/abs/cs/0701157) — where the vocabulary comes from. It shows the ANSI phenomena (dirty read, non-repeatable read, phantom) do not actually characterize the levels people run, names the anomalies that do — including write skew — and defines snapshot isolation. Read it before arguing about isolation levels with anyone.
- [PostgreSQL documentation — Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) — §13.3.2 is the fix for the lost-update half of the concept above: `FOR UPDATE` "prevents them from being locked, modified or deleted by other transactions until the current transaction ends", which is exactly what makes the second overdraft check read fresh data instead of stale. Note what it does not block: a plain `SELECT` without a locking clause reads straight past it.
- [PostgreSQL documentation — `CREATE TRIGGER`](https://www.postgresql.org/docs/current/sql-createtrigger.html) — the mechanism behind `entries_balance_check`. The paragraph that matters: constraint triggers "can be fired either at the end of the statement causing the triggering event, or at the end of the containing transaction; in the latter case they are said to be deferred", which is the whole reason two sequential entry inserts can be briefly unbalanced without tripping it.
- [PostgreSQL documentation — `SET CONSTRAINTS`](https://www.postgresql.org/docs/current/sql-set-constraints.html) — the other half: how a deferred check can be forced to run early, which is how you would debug a constraint that only fires at commit and therefore reports its failure a long way from the statement that caused it.

Elsewhere in this repo: [`mern-shop/server/src/idempotency/README.md`](../../../mern-shop/server/src/idempotency/README.md) for the general idempotency-key treatment this app's unique `reference` column is a narrower version of; [`../migrations/README.md`](../migrations/README.md) for how `balance_minor` was added to a live table without downtime, and the verification step that keeps the stored and derived balances honest; [`../outbox/README.md`](../outbox/README.md) for the row `createTransfer` writes in the same transaction as the transfer itself; [`../pagination/README.md`](../pagination/README.md) for how `GET /api/transfers` pages over the rows this domain produces.
