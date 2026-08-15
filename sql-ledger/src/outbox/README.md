# Transactional outbox

## What this is

The topic this app exists for. `POST /api/transfers` has to both write a transfer and tell the outside world it happened — and a database write plus an HTTP call is not one atomic operation. Write the transfer first and the notification can be lost (the process crashes between the two); notify first and you can announce a transfer that never actually commits. No retry logic fixes this, because the failure is *between* two independent systems with no shared transaction. The transactional outbox pattern sidesteps the problem instead of solving it: write the transfer and a row describing "notify about this" in the *same* database transaction, so they succeed or fail together by construction, and let a separate process deliver that row later, independently, with its own retry logic.

## How it works here

**The write.** `services/transfers.js`'s `createTransfer` (`src/services/transfers.js:25-47`) inserts the transfer, its two entries, the balance dual-write, *and* the outbox row (`outboxRepo.create`, `src/services/transfers.js:34-39`) inside one `withTransaction` call (`src/db.js:8-21`). If anything in that block throws — a foreign-key violation on a bad account id, a unique-violation on a repeated `reference`, anything — the whole transaction rolls back, and the outbox row rolls back with it. There is no code path where a transfer fails to commit but an outbox row survives, and no code path where a transfer commits but the outbox row doesn't exist. `test/outbox.test.js`'s first two tests assert exactly this: a committed transfer leaves exactly one outbox row (`published_at` still `null`); a transfer that fails on a bad account id leaves the `outbox` table completely empty.

**The relay.** `relayOnce` (`src/outbox/relay.js:18-42`) is one function, not a `setInterval` that only exists in production — `index.js:14-18` is the only place that wires it into a timer, and only when `OUTBOX_TARGET_URL` is configured, so every test drives `relayOnce` directly against a real `node:http` fake upstream. It opens one transaction, claims a batch with `outboxRepo.claimUnpublished` (`src/repositories/outbox.js:9-20`):

```sql
SELECT id, aggregate, aggregate_id, type, payload, attempts
FROM outbox
WHERE published_at IS NULL AND dead_lettered_at IS NULL AND attempts < $1
ORDER BY id
FOR UPDATE SKIP LOCKED
LIMIT $2
```

then, for each claimed row, calls `deliver` (`relay.js:3-11` — a plain `fetch` with `AbortSignal.timeout(2000)`) and either marks it published (`outboxRepo.markPublished`) or records the failure (`outboxRepo.recordFailure`, or `outboxRepo.deadLetter` once `attempts` would reach `maxAttempts`) — all still inside the one transaction, which commits once every claimed row has been attempted (`relay.js:34`). `backoffMs(attempts, options)` (`relay.js:13-16`) computes `random() * min(cap, base * 2 ** attempts)` — full jitter — and is exercised directly as a pure function in tests with an injected `random`, since the wiring that would use it to space out a specific row's *next* claim would need a `next_attempt_at` column this schema doesn't have (see What this toy skips).

## The core concepts

- **Dual-write across two different systems cannot be made atomic after the fact.** A database transaction and an HTTP call are governed by two different failure models — the database can guarantee its own commit is atomic, but nothing can make "commit the database write" and "the HTTP call succeeded" atomic *with each other*, because there is no shared coordinator between them (that is literally what a distributed transaction protocol like two-phase commit exists to attempt, at a cost most systems aren't willing to pay). The outbox pattern doesn't solve this — it routes around it, by turning "notify the outside world" into "write one more row in the same database transaction," which the database's own atomicity already covers for free.
- **`FOR UPDATE SKIP LOCKED` is the single most useful Postgres feature most engineers have never used.** Without it, two relay workers both running `SELECT ... FOR UPDATE` against overlapping rows would have the second one *block* until the first's transaction commits — correct, but serializes every worker behind whichever one got there first, no matter how many workers you run. `SKIP LOCKED` instead tells Postgres "if a row I'd otherwise select is already locked by someone else, skip it, don't wait" — so N competing workers can process a queue-shaped table in parallel, each one naturally picking up whatever the others haven't already claimed. `test/outbox.test.js`'s concurrency test proves this directly: two `relayOnce` calls fired with `Promise.all` against six outbox rows never both attempt to deliver the same row.
- **Polling relay versus change-data-capture, and the tradeoff.** This relay polls: it periodically asks "any unpublished rows?" which is simple, needs nothing beyond the database this app already has, but means detection latency is bounded by the poll interval and every poll that finds nothing is a wasted round trip. Log-based CDC (Debezium reading Postgres's own logical replication stream is the standard example) instead taps the database's write-ahead log directly and pushes a change the moment it's committed, with no polling delay and no wasted queries against an empty table — at the cost of running and operating an entirely separate piece of infrastructure that understands the WAL format. Polling is the right default until the added latency or query load actually hurts; CDC is what you reach for once it does.
- **At-least-once is the guarantee — not exactly-once — and pretending otherwise is the lie this pattern exists to expose.** `test/outbox.test.js`'s last test proves this rather than asserting around it: it claims a row, delivers it for real (the fake upstream receives it), then rolls back *without* marking it published — simulating a crash between "the HTTP call succeeded" and "the database recorded that fact." The row is exactly as unpublished as it was before, so the next real `relayOnce` run claims and delivers it again. The test asserts the duplicate happens. There is no version of a polling relay (or, for that matter, a CDC-based one) that can close this window completely, because "deliver the message" and "record that it was delivered" are still two separate operations even once the *original* dual-write problem is solved — you've moved the seam, not removed it. This is why every message here carries a stable outbox row id: the guarantee this system provides is "you will receive this at least once," and the consumer's own idempotency (the same `mern-shop/server/src/idempotency/README.md` treatment referenced from `src/ledger/README.md`) is what turns "at least once" into "effectively exactly once" from the consumer's point of view. The relay cannot provide that guarantee; only a consumer that dedupes on the message id can.
- **Ordering: per-aggregate is cheap, global is expensive.** Claiming `ORDER BY id` and processing claimed rows in that order gives per-aggregate ordering almost for free here, because every row for a given transfer is inserted together and ids are monotonic — but two different relay workers running concurrently, each claiming a different batch, can still deliver two *different* aggregates' messages in an order that doesn't match global insertion order. Guaranteeing a single global order across all aggregates would mean going back to exactly the one-worker-at-a-time serialization `SKIP LOCKED` exists to avoid — ordering and competing-consumer throughput are in direct tension, and this app deliberately keeps the throughput.
- **Poison messages and dead-letter queues.** A row whose delivery will never succeed (a permanently malformed payload, a permanently-down downstream) would otherwise be reclaimed by every relay poll forever, forever failing and forever blocking nothing else (since `SKIP LOCKED` already lets other rows through) but forever costing a wasted attempt. `deadLetter` (`src/repositories/outbox.js:30-35`) stops that once `attempts` reaches `maxAttempts`: the row is marked with `dead_lettered_at` and excluded from `claimUnpublished`'s `WHERE` clause from then on, so it stops being retried — `test/outbox.test.js`'s dead-letter test proves a bad row parking this way doesn't block a later, healthy row from still delivering in the same relay run.
- **Backoff with full jitter, and why the jitter matters.** Exponential backoff alone (`base * 2^attempts`) fixes the "retry immediately, forever, in lockstep" problem, but if many rows fail at the same moment, they all compute the *same* delay and all retry at the same moment again — a synchronized thundering herd, just delayed. Full jitter (`random() * min(cap, base * 2^attempts)`, `relay.js:13-16`) spreads that same population of retries out across the whole delay window instead of at its one endpoint, which is what actually reduces contention on the recovering downstream rather than merely postponing it.
- **Outbox growth and archival, and the inbox pattern as the mirror image.** A table that only ever gains rows needs an eventual archival or deletion strategy for published rows (this app never implements one — see What this toy skips). The **inbox** pattern is the same idea facing the other direction: instead of (or in addition to) the *sender* keeping an outbox to guarantee delivery, the *consumer* keeps an inbox table recording message ids it has already processed, so a redelivered message (which, per at-least-once above, will happen) can be detected and skipped by the consumer itself — the natural place to put the "consumer's own idempotency" this README keeps pointing at.

## Standard practice

- Write the "notify" intent in the same transaction as the business write it describes — never sequence a database commit and an external call and hope both succeed.
- Use `SKIP LOCKED` for any table multiple competing workers poll from; never let workers serialize behind row locks they don't need to wait for.
- Give every relayed message a stable, consumer-visible id and document at-least-once as the guarantee — never claim exactly-once when the mechanism can't provide it.
- Cap retries and dead-letter what exceeds the cap, so one permanently-failing message can never block the rows behind it.
- Always jitter a backoff; a synchronized retry storm is barely better than no backoff at all.

## What this toy skips

- No archival or deletion of published outbox rows — the table only grows in this app. A production system typically deletes or moves rows some time after `published_at`, on a schedule separate from the relay itself.
- No `next_attempt_at` column, so `backoffMs`'s computed delay is not actually wired into which row a poll reclaims next — it's exercised as a correct, tested pure function, and used in `index.js` only to log/dead-letter reasoning, not to gate a specific row's next claim. A production relay would persist the next-eligible-retry time per row and filter on it in `claimUnpublished`'s `WHERE` clause.
- No inbox table on the consumer side — this app is only the producer/relay half of the pattern. The fake upstream in tests is a bare `node:http` server that just records what it received.
- No change-data-capture alternative actually implemented — CDC is named and scoped in the core concepts above, but this relay only ever polls.
- No metrics/alerting on outbox depth or dead-letter count — a real operator would want to know when unpublished rows are accumulating faster than the relay drains them, or when something is landing in the dead-letter state.

## Try it

Requires the app running against the real `ledger` database, with `OUTBOX_TARGET_URL` pointed at something that will actually receive the POST. The snippet below is a one-route `node:http` server that just logs whatever it receives:

```js
import http from 'node:http'
http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => { console.log('received', body); res.writeHead(200); res.end() })
}).listen(4700, '127.0.0.1', () => console.log('fake outbox target on 4700'))
```

```bash
node fake-target.js &
echo "OUTBOX_TARGET_URL=http://127.0.0.1:4700" >> .env
npm run dev
curl -s -X POST http://localhost:5002/api/transfers -H 'Content-Type: application/json' -d '{"reference":"outbox-demo-1","fromAccountId":1,"toAccountId":2,"amountMinor":250}'
```

Within `OUTBOX_POLL_MS` (default 2000ms), the fake target's log line will show the outbox row's payload.

## Further reading

- [microservices.io — Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) — Chris Richardson's canonical writeup of this exact pattern, including the polling-publisher versus transaction-log-tailing tradeoff this README's core concepts summarize.
- [PostgreSQL documentation — `SELECT` (locking clauses)](https://www.postgresql.org/docs/current/sql-select.html) — the `FOR UPDATE ... SKIP LOCKED` clause directly: "skipping locked rows provides an inconsistent view of the data... but can be used to avoid lock contention with multiple consumers accessing a queue-like table," which is precisely this relay's use case.
- [AWS Architecture Blog — Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) — the "full jitter" formula this relay's `backoffMs` implements verbatim, and the measured contention reduction it produces over plain exponential backoff.
- [PostgreSQL documentation — Logical Decoding](https://www.postgresql.org/docs/current/logicaldecoding-explanation.html) — how a tool like Debezium taps Postgres's write-ahead log directly, as the change-data-capture alternative to this relay's polling.

Elsewhere in this repo: [`../ledger/README.md`](../ledger/README.md) and [`mern-shop/server/src/idempotency/README.md`](../../../mern-shop/server/src/idempotency/README.md) for the consumer-side idempotency that turns this relay's at-least-once guarantee into an effectively-exactly-once one; [`mern-tickets/server/src/circuitBreaker/README.md`](../../../mern-tickets/server/src/circuitBreaker/README.md) and [`mern-tickets/server/src/hooks/README.md`](../../../mern-tickets/server/src/hooks/README.md) for two other ways this repo isolates a slow or failing downstream from a request that must not depend on it; [`mern-movies/server/src/notifications/README.md`](../../../mern-movies/server/src/notifications/README.md) for the fan-out README covering a different one-to-many delivery problem after a write.
