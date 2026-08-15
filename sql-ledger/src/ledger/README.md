# Ledger domain

## What this is

A minimal double-entry ledger: `accounts`, `transfers`, and `entries`. A transfer between two accounts writes exactly two entries whose `amount_minor` values sum to zero — one negative (the debit), one positive (the credit) — in a single transaction. There is no separate "debit" or "credit" table; the sign of `amount_minor` is the only thing that distinguishes them. This is the textbook shape of double-entry bookkeeping, and it is deliberately the smallest domain that makes the app's three real topics (outbox, migrations, pagination) matter: a transfer is exactly the kind of write that needs a real transaction spanning more than one table, which a schemaless store cannot make honest.

## How it works here

`POST /api/transfers` (`src/controllers/transfers.js:3-12`) adapts the request body and calls `services/transfers.js`'s `createTransfer` (`src/services/transfers.js:25-47`), which validates first (`assertValidTransferInput`, `src/services/transfers.js:18-23`: rejects a missing reference, non-integer account ids, transferring an account to itself, and a non-positive `amountMinor`) and then runs everything inside `withTransaction` (`src/db.js:8-21`): insert the `transfers` row, insert the two `entries` rows (`-amountMinor` then `+amountMinor`), dual-write both accounts' `balance_minor` (`src/repositories/accounts.js:22-24`), and insert the outbox row — all five statements, one transaction, one commit or one rollback.

Money is `BIGINT` minor units everywhere — `entries.amount_minor`, `accounts.balance_minor` — never a float and never a decimal column. A balance is either summed from `entries` (`computeDerivedBalance`, `src/repositories/accounts.js:14-20`, used by the migration's verify step) or read directly from the stored `accounts.balance_minor` column (`getStoredBalance`, `src/repositories/accounts.js:26-29`, what `GET /api/accounts/:id/balance` actually calls via `services/accounts.js`). Both must always agree — that agreement, and how it survives concurrent writers, is the entire subject of `src/migrations/README.md`.

`transfers.reference` is `UNIQUE` (`src/migrations/002_create_transfers_and_entries.sql`), which is what makes a transfer idempotent: submitting the same `reference` twice is rejected with 409 rather than double-spending (`src/services/transfers.js:43`, mapped from Postgres's `23505` unique-violation code). That is the same idea as `mern-shop/server/src/idempotency/README.md` — a natural key on the write itself, rather than a separate idempotency-key table — and worth reading there for the general treatment (a client-supplied key with its own expiry and response-replay semantics) versus the narrower case here (the ledger's own business key already happens to be a good idempotency key).

## The core concepts

- **Double-entry means every transfer is self-balancing by construction.** Summing `amount_minor` over any single transfer's entries is always zero; summing over all entries for one account gives that account's balance without ever needing a running total column to be right — which is exactly why it is safe to *also* keep a running total (`balance_minor`) as a cache, as long as something can always re-derive and check it. That "something" is `verifyBalances` (`src/migrations/verify.js`).
- **Minor units are not a formatting choice, they are a correctness requirement.** `100.10 + 100.20` is not `200.30` in IEEE-754 double precision — it is `200.29999999999998`. A ledger that stores dollars as floats will eventually disagree with itself about whether a cent exists. Storing `10010` and `10020` as `BIGINT` and dividing by 100 only at the display layer means every arithmetic operation the database or the application performs is exact integer arithmetic, with no rounding step to get wrong.
- **Derived vs. stored balance is a caching problem with a correctness twist.** A derived balance (`SUM(entries.amount_minor)`) is always correct but gets slower as an account accumulates entries. A stored balance is fast but is now a second copy of the truth that can drift from the first — through a missed dual-write, a partial failure, or a bug. `src/migrations/README.md` covers the six-step migration that introduces the stored copy safely; this README only needs you to know that both exist and both must agree.
- **Why `SERIALIZABLE` (or explicit locking) would matter the moment you add a balance check.** This app does not enforce "balance must not go negative" — nothing here rejects an overdraft. The moment it did, a plain `UPDATE accounts SET balance_minor = balance_minor + $1 WHERE id = $2` running under the default `READ COMMITTED` isolation is not enough to protect an invariant that spans *two* rows, because `READ COMMITTED` only guarantees each individual statement sees committed data — it says nothing about two concurrent transactions each separately deciding "the invariant holds" and then both committing.

  Here is the write-skew scenario, concretely: account A has balance 100 and a rule "every account's balance must stay ≥ 0". Two concurrent transfers each debit A by 60: transaction 1 reads A's balance (100), computes 100 − 60 = 40 ≥ 0, and is about to write. Transaction 2, running at the same moment, also reads A's balance (100, since transaction 1 hasn't committed yet), also computes 100 − 60 = 40 ≥ 0, and is about to write. Both checks passed because both transactions read the *same* starting balance — neither one saw the other's pending debit. Both commit. The real balance is now −20, and the invariant that both transactions individually verified is now false, even though neither transaction did anything individually wrong. This is write skew: no single row was written twice, no lock was technically violated under `READ COMMITTED`, and yet the invariant broke because it spanned data that two transactions read at the same snapshot and then both acted on. Postgres's own documentation describes exactly this class of anomaly under `SERIALIZABLE` isolation (see Further reading) — running the two transfers under `SERIALIZABLE` would cause one of them to fail with a serialization error and have to retry, which is the correct outcome. The cheaper alternative without changing isolation level is an explicit `SELECT ... FOR UPDATE` on the account row before checking the balance, which forces the second transaction to block until the first commits (or rolls back), so its balance check is no longer working from stale data.

## Standard practice

- Model money as an integer count of the smallest unit the currency has (cents, pence, öre), never as a float and never relying on a language's default decimal type without being deliberate about it.
- Keep a natural, unique business key on any write that must not be repeated, rather than bolting on a separate idempotency mechanism when the domain already has one.
- Treat a cached/derived pair of values (here, stored vs. summed balance) as needing an explicit verification path, not just an initial backfill and hope.
- Reach for `SERIALIZABLE` or explicit row locking the moment an invariant spans more than one row read across a transaction boundary — `READ COMMITTED` alone does not protect it.

## What this toy skips

- No overdraft/negative-balance protection, so the write-skew scenario above is illustrated in prose rather than reproduced as a bug in this codebase — there is no invariant here for two concurrent transfers to actually break.
- No multi-currency conversion. `accounts.currency` is stored per account but nothing here converts between currencies or rejects a transfer between two different-currency accounts.
- No reversal/void transfer type — a mis-posted transfer cannot be corrected with a compensating entry, only observed.
- No `SERIALIZABLE` isolation or explicit locking is actually used anywhere in this codebase, because there is no invariant here that needs it yet.

## Try it

Requires the app running against the real `ledger` database (see the root `README.md` for Docker/migrate/start), not the test database.

```bash
curl -s -X POST http://localhost:5002/api/accounts -H 'Content-Type: application/json' -d '{"name":"alice","currency":"USD"}'
curl -s -X POST http://localhost:5002/api/accounts -H 'Content-Type: application/json' -d '{"name":"bob","currency":"USD"}'
curl -s -X POST http://localhost:5002/api/transfers -H 'Content-Type: application/json' -d '{"reference":"demo-1","fromAccountId":1,"toAccountId":2,"amountMinor":500}'
curl -s http://localhost:5002/api/accounts/2/balance
```

## Further reading

- [Martin Fowler, PoEAA — Money](https://martinfowler.com/eaaCatalog/money.html) — why money needs its own representation rather than a language's native numeric type; this app takes the narrower path (a plain `BIGINT` column plus a currency column) rather than a full `Money` value type, but the underlying reason — "the lack of a type causes problems, the most obvious surrounding currencies" — is the same one that rules out floats here.
- [PostgreSQL documentation — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html) — the `SERIALIZABLE` section documents write skew directly, including the "could not serialize access due to read/write dependencies among transactions" error a real implementation of the balance-check scenario above would hit.

Elsewhere in this repo: [`mern-shop/server/src/idempotency/README.md`](../../../mern-shop/server/src/idempotency/README.md) for the general idempotency-key treatment this app's unique `reference` column is a narrower version of.
