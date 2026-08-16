# Topic index and roadmap

A dictionary of every concept in this repo (pick one, read its guide, run its
"Try it"), followed by the roadmap of topics not yet built, in priority order.

## Existing guides — the index

1. [Password reset](mern-shop/server/src/passwordReset/README.md) — single-use tokens, token hashing at rest, expiry windows, user enumeration, timing attacks, uniform errors, NIST password rules, bcrypt cost, session revocation on reset
2. [Rate limiting](mern-shop/server/src/rateLimit/README.md) — fixed window, sliding window, token bucket, leaky bucket, GCRA, burst math, fail open vs fail closed, RateLimit headers and the draft mess, binding-limiter reporting, distributed counters, trust proxy
3. [User blocklist](mern-shop/server/src/blocklist/README.md) — denylist vs allowlist, email normalization, `+tag` and Gmail dots, homoglyphs and UTS #39, registrable domains and the Public Suffix List, audit trails, not leaking the reason
4. [Fraud scoring](mern-shop/server/src/fraud/README.md) — rules engine vs ML, reason codes and explainability, allow/review/deny tiers, thresholds as config, review queues, velocity signals, adversarial adaptation, GDPR Article 22
5. [Idempotency keys](mern-shop/server/src/idempotency/README.md) — claim via unique index, request fingerprinting, key scoping, 409 vs waiting, leases, fencing tokens, epochs, retention TTL, request dedup vs business dedup
6. [Sessions, rotation, revocation](mern-shop/server/src/session/README.md) — JWT vs server-side sessions, short expiry as the revocation window, refresh token rotation, reuse detection, token families, algorithm confusion, `kid` and key rotation, OAuth2/OIDC scope
7. [Workflow state machines, audit logs](mern-tickets/server/src/tickets/README.md) — transitions as data, audit log vs event sourcing, append-only by convention vs constraint, SLA clocks, soft delete
8. [Authorization policy engine](mern-tickets/server/src/policy/README.md) — RBAC, ABAC, ReBAC/Zanzibar, PDP/PEP/PIP/PAP, default deny, deny-overrides, row-level vs endpoint-level, confused deputy, OPA/Cedar/XACML
9. [Keyword blocking, moderation](mern-tickets/server/src/moderation/README.md) — NFKC, zero-width stripping, homoglyph mapping, collapse repeats, Scunthorpe problem, recall vs precision, severity tiers, allowlists, Aho-Corasick
10. [Throttling](mern-tickets/server/src/throttle/README.md) — persisted token bucket, lazy refill, compare-and-swap with retry, rate limit vs throttle vs quota, backpressure vs load shedding, cost-weighted consumption, Retry-After
11. [Hook pipelines](mern-tickets/server/src/hooks/README.md) — continue/reject/transform contract, handler timeouts without cancellation, fail-open vs fail-closed per domain, registration-order dependencies, sync vs async moderation
12. [Circuit breaker](mern-tickets/server/src/circuitBreaker/README.md) — closed/open/half-open, failure rate over a window, minimum throughput, what counts as a failure, retry ordering, bulkheads, per-process state, trial admission bugs
13. [Optimistic concurrency](mern-tickets/server/src/concurrency/README.md) — lost updates, ETag/If-Match, 412 vs 428 vs 409, compare-and-swap in one statement, version integers vs timestamps, write skew, CRDTs as the next step
14. [Observability](mern-tickets/server/src/observability/README.md) — structured logging, AsyncLocalStorage correlation, RED vs USE, metric cardinality, liveness vs readiness, graceful shutdown ordering, what tracing adds
15. [Recommendations](mern-movies/server/src/recommendations/README.md) — content-based vs collaborative filtering, cold start, pure ranking functions, multipliers and reason codes, eligibility floors
16. [Fan-out and notifications](mern-movies/server/src/notifications/README.md) — fan-out-on-write vs read, the celebrity problem, unique index as dedupe, at-least-once vs at-most-once vs effectively-once, backfill and replay, notification fatigue
17. [Domain modelling](mern-movies/server/src/movies/README.md) — aggregate shapes, embedding vs referencing, upserts under concurrency
18. [Double-entry ledger, money, isolation](sql-ledger/src/ledger/README.md) — minor units, BIGINT not floats, derived vs stored balance, lost update vs write skew, SERIALIZABLE, deferred constraint triggers, append-only entries
19. [Zero-downtime migrations](sql-ledger/src/migrations/README.md) — expand-contract, dual-write, batched backfill, NOT VALID + VALIDATE, CREATE INDEX CONCURRENTLY, advisory-lock deadlocks, old and new code running together
20. [Keyset pagination](sql-ledger/src/pagination/README.md) — seek vs offset, tuple comparison, composite indexes, opaque cursors, no total counts, deep pagination as DoS
21. [Transactional outbox](sql-ledger/src/outbox/README.md) — dual-write problem, FOR UPDATE SKIP LOCKED, polling vs CDC, at-least-once, visibility timeouts, poison messages, dead-lettering, backoff with jitter, inbox pattern
22. [Job queue](sql-jobs/src/queue/README.md) — fenced leases, reapers, heartbeats, per-account fairness, priority, dead-letter and operator retry, clock skew bugs, graceful worker shutdown, when Postgres is enough
23. [Timezone-correct cadences](sql-scheduler/src/cadence/README.md) — instants vs wall-clock vs durations, DST gaps and overlaps as policy choices, TIMESTAMPTZ, the IANA tz database, why cron has no timezone story
24. [Exactly-once ticking, catch-up, drift](sql-scheduler/src/scheduler/README.md) — advisory lock for liveness, unique constraint for safety, catch-up policies (all/skip/none), grid anchoring against drift, deterministic jitter
25. [Alert dedup, hysteresis, cooldown](sql-scheduler/src/alerting/README.md) — pending/firing/resolved lifecycle, for_evaluations, consecutive clears, cooldown renotification, liveness vs lag rules, forcing real races in tests
26. [Mutation testing](tools/mutation/README.md) — mutation operators, kill vs survivor, why coverage lies, seeded sampling, resumable runs

## Roadmap — must-have

1. **Caching** — cache-aside vs write-through, TTL vs explicit invalidation, cache stampede protection (request coalescing, locks, probabilistic early expiry), HTTP caching (`Cache-Control`, ETag-for-caching, 304s), CDN layer, negative caching, stale-while-revalidate
2. **Replication and consistency** — read replicas, replication lag, read-your-writes, monotonic reads, primary vs replica routing, CAP/PACELC vocabulary, why "read replica right after write" breaks checkout
3. **Sagas / distributed transactions** — compensation, orchestration vs choreography, saga state machines, pivot transactions, why two-phase commit is avoided, building on outbox + queue
4. **Feature flags and deploy strategies** — percentage rollout, targeting, kill switches, flag lifecycle and cleanup debt, blue-green and canary deploys, flags as expand-contract for behavior
5. **Web security: injection classes** — NoSQL/SQL injection, XSS (stored/reflected/DOM), CSRF and why token-in-header auth changes it, SSRF, prototype pollution, input validation boundaries, output encoding

## Roadmap — should-have

6. **Real-time delivery** — SSE vs WebSockets vs long polling, connection state at scale, reconnect and missed-event catch-up, push vs poll cost
7. **API evolution and versioning** — additive vs breaking changes, version-in-URL vs header vs none, deprecation policy, consumer contract tests (Pact-style)
8. **Search and query plans** — `EXPLAIN ANALYZE`, index selection, covering indexes, full-text search (Postgres `tsvector`), relevance ranking basics
9. **Event schema evolution** — versioning event payloads, upcasting old events, schema registry ideas, forward/backward compatibility rules

## Roadmap — nice-to-have

10. **N+1 and dataloaders** — batching, per-request caching, the GraphQL version of the problem
11. **Node internals** — event loop phases, blocking the loop, worker threads, stream backpressure
12. **Multi-tenancy** — tenant isolation models (row/schema/database), noisy neighbours, per-tenant limits
13. **Blob storage and uploads** — presigned URLs, direct-to-storage uploads, content-type validation, lifecycle policies
