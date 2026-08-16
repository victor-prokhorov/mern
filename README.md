# mern

Practice repo for MERN-stack apps. Each app is self-contained — its own client
or server, its own dependencies, its own docs.

The apps exist to carry a set of backend topics worth knowing properly. Each
topic has a working implementation, tests that fail when the behaviour breaks,
and a README beside the code covering the concepts, standard practice, what the
toy skips, and further reading.

## Apps

| App | What it is |
|---|---|
| [mern-shop](mern-shop/) | Minimal ecommerce: catalogue, server-side cart, login, orders. Raw HTML from React, no CSS. Plus four security topics. |
| [mern-tickets](mern-tickets/) | Support-ticket API. Workflow state machine, authorization, moderation, throttling. Server only. |
| [mern-movies](mern-movies/) | Movie API. Recommendations and follow/notify fan-out. Server only. |
| [sql-ledger](sql-ledger/) | Postgres double-entry ledger. Transactional outbox, zero-downtime expand-contract migrations, keyset pagination. Server only. |
| [sql-jobs](sql-jobs/) | Postgres async job queue. Fenced leases, the reaper, backoff/jitter, dead-lettering, per-account fairness. Server only. |
| [sql-scheduler](sql-scheduler/) | Postgres-backed scheduling and alarming. Timezone-correct cadences, exactly-once ticking, catch-up policies, and alert deduplication/hysteresis. Server only. |

## Topics

Twenty-six guides, each beside the code it describes — mutation testing counts as one, same as every other row in the table below.

| Topic | Where |
|---|---|
| Password reset | [mern-shop/server/src/passwordReset](mern-shop/server/src/passwordReset/README.md) |
| Rate limiting | [mern-shop/server/src/rateLimit](mern-shop/server/src/rateLimit/README.md) |
| User blocklist | [mern-shop/server/src/blocklist](mern-shop/server/src/blocklist/README.md) |
| Fraud scoring | [mern-shop/server/src/fraud](mern-shop/server/src/fraud/README.md) |
| Idempotency keys | [mern-shop/server/src/idempotency](mern-shop/server/src/idempotency/README.md) |
| Sessions, token rotation, revocation | [mern-shop/server/src/session](mern-shop/server/src/session/README.md) |
| Workflow, state machines, audit logs | [mern-tickets/server/src/tickets](mern-tickets/server/src/tickets/README.md) |
| Authorization policy engine | [mern-tickets/server/src/policy](mern-tickets/server/src/policy/README.md) |
| Keyword blocking and moderation | [mern-tickets/server/src/moderation](mern-tickets/server/src/moderation/README.md) |
| Throttling | [mern-tickets/server/src/throttle](mern-tickets/server/src/throttle/README.md) |
| Hook pipelines | [mern-tickets/server/src/hooks](mern-tickets/server/src/hooks/README.md) |
| Circuit breaker | [mern-tickets/server/src/circuitBreaker](mern-tickets/server/src/circuitBreaker/README.md) |
| Optimistic concurrency (ETag / If-Match) | [mern-tickets/server/src/concurrency](mern-tickets/server/src/concurrency/README.md) |
| Observability: logs, metrics, health, shutdown | [mern-tickets/server/src/observability](mern-tickets/server/src/observability/README.md) |
| Recommendations | [mern-movies/server/src/recommendations](mern-movies/server/src/recommendations/README.md) |
| Fan-out and notifications | [mern-movies/server/src/notifications](mern-movies/server/src/notifications/README.md) |
| Domain modelling | [mern-movies/server/src/movies](mern-movies/server/src/movies/README.md) |
| Double-entry ledger, money, isolation | [sql-ledger/src/ledger](sql-ledger/src/ledger/README.md) |
| Zero-downtime migrations (expand-contract) | [sql-ledger/src/migrations](sql-ledger/src/migrations/README.md) |
| Keyset pagination | [sql-ledger/src/pagination](sql-ledger/src/pagination/README.md) |
| Transactional outbox | [sql-ledger/src/outbox](sql-ledger/src/outbox/README.md) |
| Job queue: fenced leases, backoff/jitter, dead-lettering, fairness | [sql-jobs/src/queue](sql-jobs/src/queue/README.md) |
| Timezone-correct cadences and DST | [sql-scheduler/src/cadence](sql-scheduler/src/cadence/README.md) |
| Exactly-once ticking, catch-up policies, drift | [sql-scheduler/src/scheduler](sql-scheduler/src/scheduler/README.md) |
| Alert dedup, hysteresis, cooldown | [sql-scheduler/src/alerting](sql-scheduler/src/alerting/README.md) |
| Mutation testing | [tools/mutation](tools/mutation/README.md) |

Several topics are treated more than once, from different angles, and the pairs are worth reading together: idempotency as a client-supplied key ([shop](mern-shop/server/src/idempotency/README.md)) against a natural business key ([ledger](sql-ledger/src/ledger/README.md)) against a unique index used for fan-out dedupe ([movies](mern-movies/server/src/notifications/README.md)); rate limiting as a fixed window at the edge ([shop](mern-shop/server/src/rateLimit/README.md)) against a token bucket per authenticated actor ([tickets](mern-tickets/server/src/throttle/README.md)); and the transactional outbox described as the fix a Mongo app cannot reach for ([movies](mern-movies/server/src/notifications/README.md)) next to a working one ([ledger](sql-ledger/src/outbox/README.md)).

## In the real world (AWS / GCP)

Several guides now carry an "In the real world (AWS / GCP)" section mapping the
hand-built mechanism onto the managed service that replaces it in production —
what the service absorbs, and what stays your code no matter what you buy.
The mappings, in one table:

| Hand-built here | AWS | GCP |
|---|---|---|
| Job queue: lease, reaper, heartbeat, DLQ ([sql-jobs](sql-jobs/src/queue/README.md)) | SQS (visibility timeout, redrive/DLQ), Lambda/ECS workers | Cloud Tasks / Pub/Sub (ack deadline, dead-letter topic), Cloud Run workers |
| Transactional outbox + polling relay ([sql-ledger](sql-ledger/src/outbox/README.md)) | Debezium on MSK Connect, EventBridge/SNS | Datastream, Pub/Sub |
| Timezone-correct scheduling, tick loop ([sql-scheduler](sql-scheduler/src/scheduler/README.md)) | EventBridge Scheduler | Cloud Scheduler, Cloud Tasks |
| Alert dedup, hysteresis, cooldown ([sql-scheduler](sql-scheduler/src/alerting/README.md)) | CloudWatch Alarms + SNS | Cloud Monitoring alerting + notification channels |
| Sessions, JWT, rotation, revocation ([mern-shop](mern-shop/server/src/session/README.md)) | Cognito, KMS/Secrets Manager | Identity Platform / Firebase Auth, Cloud KMS |
| Rate limiting at three layers ([mern-shop](mern-shop/server/src/rateLimit/README.md)) | WAF rate rules, API Gateway usage plans, ElastiCache | Cloud Armor, Apigee, Memorystore |
| Idempotency keys ([mern-shop](mern-shop/server/src/idempotency/README.md)) | DynamoDB conditional writes (see Lambda Powertools idempotency) | Firestore `create()` |
| Logs / metrics / probes / shutdown ([mern-tickets](mern-tickets/server/src/observability/README.md)) | CloudWatch, X-Ray, ALB health checks | Cloud Logging/Monitoring/Trace, Cloud Run probes |
| Fan-out notifications ([mern-movies](mern-movies/server/src/notifications/README.md)) | SNS→SQS, SES/Pinpoint | Pub/Sub multi-subscription, FCM |
| Keyset pagination ([sql-ledger](sql-ledger/src/pagination/README.md)) | DynamoDB `LastEvaluatedKey` | Firestore `startAfter` |

On database choice, the short version this repo teaches by construction:
`sql-ledger` exists because a money ledger needs multi-row transactions and
database-enforced invariants — relational (RDS/Aurora, Cloud SQL/AlloyDB,
Spanner) is the default there. The MERN apps show where a document store is
fine: single-document atomicity plus unique indexes cover sessions, rate
limits, idempotency claims, and notifications, and every place that stops
being enough is called out in the corresponding guide (the movies fan-out
that cannot reach a transactional outbox on standalone Mongo is the clearest
example). Key-value-shaped workloads (sessions by token hash, notifications
by user) map naturally onto DynamoDB/Firestore; anything whose invariant
spans rows does not.

## Requirements

- Node 20+
- MongoDB on `mongodb://127.0.0.1:27017` for the three MERN apps
- PostgreSQL on `postgres://postgres:postgres@127.0.0.1:5432` for `sql-ledger`, `sql-jobs`, and `sql-scheduler`

Neither installed locally? Run them in Docker:

```bash
docker run -d --name mern-mongo -p 27017:27017 --restart unless-stopped mongo:7
docker run -d --name mern-postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres --restart unless-stopped postgres:16
```

## Running the MERN apps

```bash
cd <app>/server
npm install
cp .env.example .env
npm run seed
npm run dev
```

One thing `.env.example` alone does not tell you:

- **`mern-shop` will not start without `JWT_SECRET`.** `src/session/tokens.js`
  throws at import rather than fall back to a hardcoded signing key.
  `mern-shop/server/.env.example` ships a `JWT_SECRET` placeholder so
  `cp .env.example .env` followed by `npm run dev` works verbatim, but the
  placeholder is exactly that — replace it with a real secret before this
  app ever runs anywhere but a laptop. The blocklist guide additionally needs
  `ADMIN_TOKEN` and the password-reset guide needs `EXPOSE_RESET_TOKEN=1`; see
  [mern-shop/README.md](mern-shop/README.md) for the table.

Ports, in one place: `mern-shop` 5000, `mern-tickets` 5001, `mern-movies` 5003,
`sql-ledger` 5002, `sql-jobs` 5004, `sql-scheduler` 5005, `mern-shop`'s Vite
client 5173. Each app's `.env.example` ships its own distinct default, so any
two (or all six) can run side by side without an `EADDRINUSE` — which several
guides' "Try it" sections already assumed when they point at each other.

`mern-shop` also has a client:

```bash
cd mern-shop/client
npm install
npm run dev
```

## Running the SQL apps

Different shape: no `server/` subdirectory, and migrations instead of (or in
addition to) fixtures. `sql-ledger` has no seed script; `sql-jobs` and
`sql-scheduler` have one.

```bash
cd sql-ledger   # or sql-jobs / sql-scheduler
npm install
cp .env.example .env
npm run migrate
npm run seed    # sql-jobs and sql-scheduler only
npm run dev
```

## Tests

```bash
cd <app>/server   # or just cd sql-ledger
npm test        # drops and rebuilds its own <app>-test database on every test
npm run test:ci # same, plus JUnit XML in test-results/
```

458 tests across six apps (124 shop, 141 tickets, 58 movies, 46 ledger,
26 jobs, 63 scheduler), plus a mutation-testing tool under `tools/mutation`
that audits how much those tests actually prove.
The MERN suites need a reachable MongoDB; `sql-ledger`, `sql-jobs` and
`sql-scheduler` need a reachable Postgres and each creates its own
`<app>_test` database on first run.

## Mutation testing

`tools/mutation` is a hand-rolled mutation testing runner used to audit the
test suites above — it mutates one line of source at a time, reruns the app's
real test suite, and records whether the suite noticed. A green suite with a
100% coverage report can still be at 0% mutation score if nothing checks the
behaviour that changed, which is exactly the failure mode it exists to catch.

```bash
cd tools/mutation
node cli.js --app mern-shop --files src/middleware/auth.js --max 20 --seed demo
```

See [tools/mutation/README.md](tools/mutation/README.md) for how it works and
what running it against mern-shop, mern-tickets, mern-movies, and sql-ledger
found — that audit predates `sql-jobs` and has not been run against it.

## House rules

These are constraints on the exercise, not recommendations for production.

- A closed dependency list per app. No Redis, no rate-limit package, no policy
  engine, no moderation library, no ORM or migration library in `sql-ledger` —
  the point is building them and understanding the tradeoffs, so anything that
  hides the mechanism is out.
- No comments in source. Explanation belongs in the READMEs, where it can be
  long enough to be true.
- No CSS anywhere. Raw HTML tags only.
- Servers are layered: routes wire, controllers adapt HTTP, services hold rules,
  repositories own every database call. Only repositories import models, and no
  service or repository mentions `req` or `res`.
