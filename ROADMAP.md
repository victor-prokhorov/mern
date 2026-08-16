# Topic index and roadmap

Three things, in order: (1) the master concept checklist — the full list of
what a senior/staff backend engineer and architect should master, grouped by
area, each marked `[covered]` with a link, `[roadmap]` if planned here, or
unmarked if it is a real gap not in this repo yet; (2) the index of the 27
guides that exist, as a concept dictionary; (3) the roadmap of unbuilt topics
in priority order. Scan section 1 to pick a weakness; jump to section 2 for
anything already built.

## Master concept checklist — what to master

The point of this section is coverage honesty: it lists the field, not just
the parts this repo happens to teach, so an unmarked line is a known blind
spot rather than a thing that doesn't matter.

### Data storage and modelling
- Relational vs document vs key-value vs wide-column vs graph — picking by workload `[covered]` ([ledger](sql-ledger/src/ledger/README.md), [domain modelling](mern-movies/server/src/movies/README.md))
- Normalization vs denormalization, embedding vs referencing `[covered]` ([domain modelling](mern-movies/server/src/movies/README.md))
- Money and exact numerics (minor units, BIGINT not float, ISO 4217) `[covered]` ([ledger](sql-ledger/src/ledger/README.md))
- Indexes: composite, covering, partial, unique; index selection and `EXPLAIN` `[roadmap]` (should-have #8) — partial today via ([pagination](sql-ledger/src/pagination/README.md))
- Schema migrations: expand-contract, zero-downtime DDL, backfills `[covered]` ([migrations](sql-ledger/src/migrations/README.md))
- Pagination: keyset vs offset, opaque cursors `[covered]` ([pagination](sql-ledger/src/pagination/README.md))
- Full-text search, relevance ranking, `tsvector` `[roadmap]` (should-have #8)
- Time and timezones: instants vs wall-clock, DST, TIMESTAMPTZ, IANA tz `[covered]` ([cadence](sql-scheduler/src/cadence/README.md))
- Blob/object storage, presigned uploads, lifecycle `[roadmap]` (nice-to-have #16)
- Partitioning and sharding (by range, hash, tenant) — not built
- Data retention, archival, TTL/reaping `[covered]` (idempotency/rate-limit TTL, outbox growth notes)

### Consistency, transactions, concurrency
- ACID, isolation levels (READ COMMITTED, REPEATABLE READ, SERIALIZABLE) `[covered]` ([ledger](sql-ledger/src/ledger/README.md))
- Lost update vs write skew vs phantoms `[covered]` ([ledger](sql-ledger/src/ledger/README.md))
- Optimistic vs pessimistic locking, compare-and-swap, ETag/If-Match `[covered]` ([concurrency](mern-tickets/server/src/concurrency/README.md))
- TOCTOU (time-of-check-to-time-of-use) / check-then-act races — the name for the bug behind lost updates and check-then-insert `[covered]` (demonstrated, not labelled: ([idempotency](mern-shop/server/src/idempotency/README.md)) check-then-act, ([ledger](sql-ledger/src/ledger/README.md)) lost update)
- Row locking, `FOR UPDATE`, `SKIP LOCKED`, advisory locks `[covered]` ([outbox](sql-ledger/src/outbox/README.md), [queue](sql-jobs/src/queue/README.md), [migrations](sql-ledger/src/migrations/README.md))
- Fencing tokens, leases, and why a lease alone is not enough `[covered]` ([idempotency](mern-shop/server/src/idempotency/README.md), [queue](sql-jobs/src/queue/README.md))
- CAP / PACELC, replication lag, read-your-writes, monotonic reads `[roadmap]` (must-have #2)
- CRDTs and convergent merge (the step past whole-document rejection) `[covered]` (concept only, ([concurrency](mern-tickets/server/src/concurrency/README.md)))
- Distributed transactions, two-phase commit, and why they are avoided `[roadmap]` (must-have #3)
- Sagas and compensation (orchestration vs choreography) `[roadmap]` (must-have #3)
- Idempotency: client keys, natural keys, unique-index dedupe `[covered]` ([idempotency](mern-shop/server/src/idempotency/README.md), [ledger](sql-ledger/src/ledger/README.md), [fan-out](mern-movies/server/src/notifications/README.md))

### Messaging and async work
- Queues: leases, reapers, retries, backoff+jitter, dead-letter, fairness `[covered]` ([queue](sql-jobs/src/queue/README.md))
- Transactional outbox, polling relay vs CDC, inbox pattern `[covered]` ([outbox](sql-ledger/src/outbox/README.md))
- Delivery semantics: at-least-once, at-most-once, effectively-once `[covered]` ([outbox](sql-ledger/src/outbox/README.md), [fan-out](mern-movies/server/src/notifications/README.md), [queue](sql-jobs/src/queue/README.md))
- Fan-out on write vs on read, the celebrity problem `[covered]` ([fan-out](mern-movies/server/src/notifications/README.md))
- Ordering guarantees, partitions, consumer groups — concept only (queue README)
- Event schema evolution, upcasting, schema registry `[roadmap]` (should-have #9)
- Scheduling: cron vs polling ticks, catch-up, drift, exactly-once fire `[covered]` ([scheduler](sql-scheduler/src/scheduler/README.md), [cadence](sql-scheduler/src/cadence/README.md))
- Backpressure vs load shedding `[covered]` (concept, ([throttle](mern-tickets/server/src/throttle/README.md)))

### Caching and performance
- Cache-aside, write-through, write-behind `[covered]` (cache-aside built; write-through/write-behind concept, ([caching](mern-cache/server/src/cache/README.md)))
- Cache eviction policies: LRU, LFU, FIFO, ARC, TTL, and size/memory pressure `[covered]` (TTL reclaim only; LRU/LFU/ARC discussed as skipped, ([caching](mern-cache/server/src/cache/README.md)))
- TTL vs invalidation, negative caching, stale-while-revalidate `[covered]` (TTL, invalidation, negative caching built; stale-while-revalidate concept, ([caching](mern-cache/server/src/cache/README.md)))
- Cache stampede / thundering herd, single-flight, early expiry `[covered]` (single-flight built; probabilistic early expiry concept, ([caching](mern-cache/server/src/cache/README.md)))
- HTTP caching: Cache-Control, ETag, 304, CDN edge `[covered]` (concept, in the caching guide's prose and its ETag contrast with ([concurrency](mern-tickets/server/src/concurrency/README.md)), ([caching](mern-cache/server/src/cache/README.md)))
- N+1 queries and dataloaders/batching `[roadmap]` (nice-to-have #13)
- Connection pooling, prepared statements — concept only
- Query plans and index-driven performance `[roadmap]` (should-have #8)

### API design
- REST semantics, idempotent methods, status codes (409/412/428/429) `[covered]` ([concurrency](mern-tickets/server/src/concurrency/README.md), [throttle](mern-tickets/server/src/throttle/README.md))
- Versioning and breaking-change policy, consumer contract tests `[roadmap]` (should-have #7)
- Pagination contracts, opaque tokens (AIP-158) `[covered]` ([pagination](sql-ledger/src/pagination/README.md))
- Rate-limit response contract (Retry-After, RateLimit headers) `[covered]` ([rate limiting](mern-shop/server/src/rateLimit/README.md), [throttle](mern-tickets/server/src/throttle/README.md))
- Real-time: SSE, WebSockets, long polling `[roadmap]` (should-have #6)
- GraphQL vs REST, query cost — concept only (throttle mentions Shopify cost model)

### Authentication, authorization, security
- Password storage (bcrypt/Argon2), NIST rules, reset flows `[covered]` ([password reset](mern-shop/server/src/passwordReset/README.md))
- Sessions vs JWT, rotation, reuse detection, revocation, `kid` `[covered]` ([sessions](mern-shop/server/src/session/README.md))
- OAuth2 / OIDC scope and grants `[covered]` (concept, ([sessions](mern-shop/server/src/session/README.md)))
- Authorization models: RBAC, ABAC, ReBAC, PDP/PEP `[covered]` ([policy](mern-tickets/server/src/policy/README.md))
- Rate limiting and credential-stuffing defence `[covered]` ([rate limiting](mern-shop/server/src/rateLimit/README.md))
- Blocklists, normalization, homoglyphs, enumeration oracles `[covered]` ([blocklist](mern-shop/server/src/blocklist/README.md))
- Injection: SQL/NoSQL, XSS, CSRF, SSRF, prototype pollution `[roadmap]` (must-have #5)
- Fraud scoring, reason codes, explainability, GDPR Art. 22 `[covered]` ([fraud](mern-shop/server/src/fraud/README.md))
- Content moderation, keyword/allowlist, Unicode security `[covered]` ([moderation](mern-tickets/server/src/moderation/README.md))
- Secrets management, key rotation `[covered]` (concept, ([sessions](mern-shop/server/src/session/README.md)) + AWS/GCP sections)
- Multi-tenancy isolation `[roadmap]` (nice-to-have #15)
- Audit logs vs event sourcing, tamper-evidence `[covered]` ([tickets](mern-tickets/server/src/tickets/README.md), [ledger](sql-ledger/src/ledger/README.md))

### Reliability and resilience
- Timeouts (why every remote call needs one) `[covered]` ([circuit breaker](mern-tickets/server/src/circuitBreaker/README.md))
- Retries, exponential backoff, full jitter `[covered]` ([outbox](sql-ledger/src/outbox/README.md), [queue](sql-jobs/src/queue/README.md), [alerting](sql-scheduler/src/alerting/README.md))
- Circuit breakers (closed/open/half-open) `[covered]` ([circuit breaker](mern-tickets/server/src/circuitBreaker/README.md))
- Bulkheads, load shedding, hedged requests `[covered]` (concept, ([circuit breaker](mern-tickets/server/src/circuitBreaker/README.md)))
- Graceful shutdown, connection draining `[covered]` ([observability](mern-tickets/server/src/observability/README.md), [queue](sql-jobs/src/queue/README.md))
- Fail-open vs fail-closed per domain `[covered]` ([hooks](mern-tickets/server/src/hooks/README.md))
- Cascading failure, thundering herd on recovery `[covered]` (concept across breaker/backoff guides)
- Dependability taxonomy: fault vs error vs failure (Avizienis), MTBF/MTTR, blast radius — the vocabulary — not built
- Fault tolerance vs fault avoidance, redundancy, graceful degradation `[covered]` (concept, ([circuit breaker](mern-tickets/server/src/circuitBreaker/README.md)) fallbacks)

### Observability and operations
- Structured logging, correlation ids, AsyncLocalStorage `[covered]` ([observability](mern-tickets/server/src/observability/README.md))
- Metrics: RED vs USE, cardinality, Prometheus exposition `[covered]` ([observability](mern-tickets/server/src/observability/README.md))
- Distributed tracing, spans, OpenTelemetry `[covered]` (concept, ([observability](mern-tickets/server/src/observability/README.md)))
- Health checks: liveness vs readiness `[covered]` ([observability](mern-tickets/server/src/observability/README.md))
- Alerting: dedup, hysteresis, cooldown, liveness vs lag rules `[covered]` ([alerting](sql-scheduler/src/alerting/README.md))
- Latency as a distribution: p50/p95/p99/p999, tail latency, why averages lie `[covered]` (concept only, ([circuit breaker](mern-tickets/server/src/circuitBreaker/README.md)) slow-is-worse-than-failed, ([observability](mern-tickets/server/src/observability/README.md)) duration histogram) — no dedicated treatment
- Availability, SLIs/SLOs/error budgets, the nines — not built (mechanics exist; the discipline does not)

### Microservices and inter-service communication
- Sync RPC vs async messaging vs shared-DB integration — choosing the boundary — not built
- gRPC and HTTP/2 (streaming, multiplexing, deadlines, interceptors) — not built
- Binary serialization: Protobuf, Avro, Thrift, MessagePack vs JSON — size, speed, and schema `[covered]` (concept only, via serialization tradeoffs in AWS/GCP notes) — no dedicated guide
- Schema/IDL evolution: field numbers, forward/backward compatibility, schema registry `[roadmap]` (should-have #9, event side) — RPC/IDL side not built
- Service discovery, client-side vs server-side load balancing — not built
- Service mesh (Envoy, Istio), sidecars, outlier detection `[covered]` (concept only, ([circuit breaker](mern-tickets/server/src/circuitBreaker/README.md)) contrasts app-level breaker vs mesh)
- API gateway, backend-for-frontend (BFF), edge aggregation `[covered]` (concept only, across AWS/GCP sections)
- Contract testing across service boundaries (Pact) `[roadmap]` (should-have #7)
- OpenAPI / Swagger: spec-first vs code-first, codegen, request/response validation from the contract `[roadmap]` (should-have #11)
- Distributed tracing across hops, context propagation `[covered]` (concept, ([observability](mern-tickets/server/src/observability/README.md)))
- Monolith vs microservices vs modular monolith — the actual tradeoff — not built

### Containers, orchestration, platform
- Containers and images: layering, multi-stage builds, minimal base images — not built
- Kubernetes core objects: Pod, Deployment, ReplicaSet, Service, Ingress, ConfigMap, Secret `[roadmap]` (should-have #12)
- Liveness/readiness/startup probes `[covered]` (the app side, ([observability](mern-tickets/server/src/observability/README.md))) — the K8s wiring itself not built
- Rolling updates, `terminationGracePeriodSeconds`, graceful shutdown contract `[covered]` (app side, ([observability](mern-tickets/server/src/observability/README.md), [queue](sql-jobs/src/queue/README.md)))
- Horizontal Pod Autoscaler, resource requests/limits, QoS — not built
- Config and secrets injection, 12-factor config — concept only (env-var config used repo-wide)
- Service mesh at the platform layer (Istio/Linkerd) — see inter-service comms above
- Serverless (Lambda, Cloud Run) as the alternative to orchestrating long-lived processes `[covered]` (concept, across the AWS/GCP sections)

### Networking fundamentals
- OSI model and the TCP/IP layers (link, internet/IP, transport, application) — not built
- TCP vs UDP: handshakes, ordering, flow/congestion control, when UDP wins — not built
- IP, routing, NAT, ports; DNS resolution and caching — not built
- HTTP/1.1 vs HTTP/2 (multiplexing) vs HTTP/3 (QUIC); keep-alive, head-of-line blocking — partial (HTTP/2 comes up in the gRPC line; keep-alive in ([observability](mern-tickets/server/src/observability/README.md)) shutdown)
- TLS: handshake, certificates, mTLS, termination at the edge — not built
- Load balancers (L4 vs L7), reverse proxies, connection pooling — concept only

### Regionalization and geo-distribution
- Single-region vs multi-region; active-active vs active-passive — not built
- Latency-based / geo routing, anycast, edge/CDN presence — not built
- Cross-region replication and its lag; conflict handling — links to must-have #2 (replication)
- Data residency and sovereignty (GDPR, regional data boundaries) — not built
- Regional failover, disaster recovery, RPO/RTO — not built

### Scaling and distribution
- Horizontal vs vertical scaling, statelessness — concept only
- Read replicas and replica routing `[roadmap]` (must-have #2)
- Sharding / partitioning strategies — not built
- Leader election, single-active-instance (advisory lock) `[covered]` ([scheduler](sql-scheduler/src/scheduler/README.md))
- Per-process vs shared state (breaker, health) `[covered]` ([circuit breaker](mern-tickets/server/src/circuitBreaker/README.md))
- Consistent hashing — not built
- Multi-region topology and geo-distribution — see the Regionalization group above

### Deployment and release
- Blue-green, canary, rolling deploys `[roadmap]` (must-have #4)
- Feature flags, targeting, kill switches, flag debt `[roadmap]` (must-have #4)
- Backwards-compatible deploys (old+new code together) `[covered]` ([migrations](sql-ledger/src/migrations/README.md))
- Infrastructure as code, immutable infra — not built

### Testing and quality
- Test doubles, dependency injection for testability `[covered]` (pattern throughout; injected clocks/stores)
- Concurrency tests that force the real interleaving `[covered]` ([alerting](sql-scheduler/src/alerting/README.md), [scheduler](sql-scheduler/src/scheduler/README.md))
- Mutation testing (coverage lies) `[covered]` ([mutation](tools/mutation/README.md))
- Contract tests, property-based testing — concept only / not built

### Domain and architecture
- Layered architecture, dependency direction `[covered]` (enforced repo-wide; sql `check-layers.js`)
- Domain-driven design: bounded contexts, aggregates as consistency boundaries, ubiquitous language, context mapping — partial (aggregate/embedding shapes in ([domain modelling](mern-movies/server/src/movies/README.md)); DDD proper not built)
- State machines vs scattered conditionals `[covered]` ([tickets](mern-tickets/server/src/tickets/README.md))
- Rules engines vs ML, explainable decisions `[covered]` ([fraud](mern-shop/server/src/fraud/README.md))
- Recommendations: content vs collaborative filtering, cold start `[covered]` ([recommendations](mern-movies/server/src/recommendations/README.md))
- Hooks/pipelines vs middleware vs events `[covered]` ([hooks](mern-tickets/server/src/hooks/README.md))
- Node runtime internals: event loop, workers, stream backpressure `[roadmap]` (nice-to-have #14)

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
27. [Caching](mern-cache/server/src/cache/README.md) — cache-aside vs write-through/write-behind, TTL as a staleness bound vs invalidation-on-write, negative caching, the cache stampede and single-flight coalescing, HTTP caching (Cache-Control/ETag/304/CDN) and how its ETag differs from the write-side ETag, per-process vs distributed limits

## Roadmap — must-have

1. **Caching** — **built**, see [`mern-cache/server/src/cache/README.md`](mern-cache/server/src/cache/README.md): cache-aside vs write-through, TTL vs explicit invalidation, cache stampede protection (request coalescing, locks, probabilistic early expiry), HTTP caching (`Cache-Control`, ETag-for-caching, 304s), CDN layer, negative caching, stale-while-revalidate
2. **Replication and consistency** — read replicas, replication lag, read-your-writes, monotonic reads, primary vs replica routing, CAP/PACELC vocabulary, why "read replica right after write" breaks checkout
3. **Sagas / distributed transactions** — compensation, orchestration vs choreography, saga state machines, pivot transactions, why two-phase commit is avoided, building on outbox + queue
4. **Feature flags and deploy strategies** — percentage rollout, targeting, kill switches, flag lifecycle and cleanup debt, blue-green and canary deploys, flags as expand-contract for behavior
5. **Web security: injection classes** — NoSQL/SQL injection, XSS (stored/reflected/DOM), CSRF and why token-in-header auth changes it, SSRF, prototype pollution, input validation boundaries, output encoding

## Roadmap — should-have

6. **Real-time delivery** — SSE vs WebSockets vs long polling, connection state at scale, reconnect and missed-event catch-up, push vs poll cost
7. **API evolution and versioning** — additive vs breaking changes, version-in-URL vs header vs none, deprecation policy, consumer contract tests (Pact-style)
8. **Search and query plans** — `EXPLAIN ANALYZE`, index selection, covering indexes, full-text search (Postgres `tsvector`), relevance ranking basics
9. **Event schema evolution** — versioning event payloads, upcasting old events, schema registry ideas, forward/backward compatibility rules
10. **Inter-service communication and binary serialization** — sync RPC vs async messaging boundary, gRPC over HTTP/2 (streaming, deadlines, interceptors), Protobuf/Avro/Thrift/MessagePack vs JSON (size, speed, schema), IDL evolution and field-number compatibility, service discovery, load balancing, service mesh vs app-level resilience

11. **OpenAPI-driven APIs** — spec-first design, generated clients/servers, runtime request/response validation against the contract, keeping the spec and code from drifting
12. **Kubernetes deployment** — containerizing one of these apps, Deployment + Service + Ingress, probes wired to `/healthz`/`/readyz`, ConfigMap/Secret injection, rolling update + graceful shutdown, resource limits and an HPA

## Roadmap — nice-to-have

13. **N+1 and dataloaders** — batching, per-request caching, the GraphQL version of the problem
14. **Node internals** — event loop phases, blocking the loop, worker threads, stream backpressure
15. **Multi-tenancy** — tenant isolation models (row/schema/database), noisy neighbours, per-tenant limits
16. **Blob storage and uploads** — presigned URLs, direct-to-storage uploads, content-type validation, lifecycle policies
