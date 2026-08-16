# Architecture cheat cards

Patterns for design discussions: what problem each one solves, what you pay for it,
where it bites, and the words that make you precise at the whiteboard. Every card is
scan-first: Signal tells you when to reach for it, Invariant is the rule that must hold
or the pattern silently fails, Say no when keeps you honest.

How to read a card:

- **Signal** — symptoms that suggest this pattern.
- **One-liner** — the pattern in one sentence you can say out loud.
- **Get / Pay** — the trade. Every pattern is a trade; if someone presents one as free, one side is hidden.
- **Invariant** — the condition that must hold. Break it and the pattern makes things worse, not better.
- **Alarms** — what to measure in production.
- **Classic mistakes** — how teams actually get burned.
- **Say no when** — situations where the pattern is the wrong answer.
- **Words** — vocabulary that makes the discussion precise.

---

## First questions (before any pattern)

Ask these before proposing anything; the answers pick the pattern for you.

1. **Numbers.** Requests per second, average and peak. Payload size. Read/write ratio.
   Data size now and in two years. A design discussion without numbers is a taste discussion.
   (Throughout: λ is arrival rate, μ is service rate — how fast work comes in vs how fast it is handled.)
2. **Who waits?** For each operation: does a human wait for the result, another service,
   or nobody? This single question decides sync vs async.
3. **What breaks first?** The bottleneck resource: CPU, one database, one lock, one
   third-party API. Patterns move bottlenecks; know which one you are moving and where to.
4. **Consistency needs, per operation.** "Everything strongly consistent" is a non-answer;
   so is "eventual is fine everywhere". Charging money and counting page views differ.
5. **Blast radius.** When this component fails at 3am, what else goes down, and what does
   the user see?
6. **Little's Law.** L = λW: items in the system = arrival rate x time each item spends
   inside. It binds every queue, pool, and buffer you will ever size. If arrival rate λ
   exceeds service rate, W grows without bound — nothing changes that except more capacity
   or deliberately refusing work (see backpressure and load shedding).
7. **Rollback path.** How do you undo this decision in six months? Reversible decisions
   deserve minutes; irreversible ones deserve the meeting.

```
the whole doc in one picture:

  client ──> [edge/CDN] ──> [gateway] ──> [service] ──> [cache] ──> [DB primary]
                                │             │                        │
                             (limits,      [queue] ──> workers      [replicas]
                              auth)           │
                                           retries, dead-letter queue
  every box: a trade. every arrow: a timeout, a retry policy, a failure mode.
```

---

## Load and throughput

### Message queue

**Signal:** bursty load; p99 spikes at peak while workers idle off-peak; work has no human waiting on the result.
**One-liner:** buffer between producer and consumer — accept at peak rate, process at average rate.

```
in ~~/\~~/\/\~~ (bursty) ──> [■■■■□□] queue ──> out ------ (steady, sized to avg)
```

**Get:** burst absorption · fleet sized for average, not peak · producer/consumer failure isolation · retry for free (redelivery).
**Pay:** async completion — the caller needs a signal (poll, webhook, socket) · variable end-to-end latency · consumers must be idempotent · backlog is a new failure mode.
**Invariant:** average inflow < drain rate. A queue absorbs variance around a sustainable mean; it cannot absorb an unsustainable mean. If λ > μ, depth grows without bound — you have hidden the overload, not fixed it, and it fails later with a pile of stale work in front of the fresh work.
**Alarms:** oldest-message age (primary), depth trend, DLQ rate, consumer lag, redelivery rate. Depth alone lies: deep-but-draining is healthy, shallow-but-stuck is not.
**Classic mistakes:** no dead-letter queue, so one poison message wedges the pipeline · non-idempotent consumer double-charges on redelivery · alerting on depth instead of age · using the queue as the fix for sustained overload · assuming global ordering (you get per-partition at best).
**Say no when:** the caller needs the result synchronously · average load already exceeds capacity (fix capacity or the hot path first) · the "burst" is actually one slow query.
**Words:** drain rate, backpressure, at-least-once / at-most-once, idempotent consumer, dead-letter queue (DLQ), poison message, consumer lag, head-of-line blocking, visibility timeout.

### Load balancing

**Signal:** one machine at its ceiling; deploys cause downtime; a single instance is a single point of failure.
**One-liner:** spread requests across N interchangeable instances so capacity and availability scale with N.

```
            ┌─> instance A
client ─> [LB] ─> instance B     any instance can die; the herd survives
            └─> instance C
```

**Get:** horizontal capacity · zero-downtime deploys (rolling) · instance failure tolerance.
**Pay:** instances must be stateless (or you need sticky sessions, which undo half the benefit) · the LB is itself a component that fails · health checking becomes load-bearing.
**Invariant:** instances are interchangeable. Any local state (in-memory session, local file, local cache acting as truth) breaks the model — externalize it (DB, Redis, object store) first.
**Alarms:** per-instance error rate and latency skew (one bad instance hides in the average), health-check flap rate, connection distribution.
**Classic mistakes:** sticky sessions as a crutch for in-memory state · health check tests "process up" instead of "can serve" (instance passes checks while erroring) · health check tests too much and one slow dependency marks the whole fleet down, turning a partial outage into a full one · least-connections vs round-robin never revisited after workloads change.
**Say no when:** say no to *adding instances* when the shared database behind them is the bottleneck — N app servers hammering one primary just moves the queue. The balancer itself still earns its keep for deploys and failover even on a DB-bound service.
**Words:** stateless, sticky session / session affinity, health check, connection draining, round-robin, least-connections, L4 vs L7.

### Caching

**Signal:** the same expensive read happens repeatedly; read-heavy ratio; latency dominated by a downstream call or query.
**One-liner:** keep a copy of expensive-to-compute data close to the reader and serve the copy.

```
read:  client ─> [cache] ── hit ──> return          (fast path, most traffic)
                    └── miss ─> [DB] ─> fill cache ─> return
```

**Get:** latency drop of one or more orders of magnitude · shields the source of truth from read load.
**Pay:** staleness — you now serve data that may be wrong · invalidation logic, one of the genuinely hard problems · a new fleet to operate · cold-start / stampede behavior.
**Invariant:** the cache is disposable. If wiping it takes the system down (thundering herd onto the DB), the cache stopped being an optimization and became a hidden load-bearing tier — size the source of truth for cache-miss reality, or add stampede protection.
**Alarms:** hit rate, origin load during cache node restarts, key hotspots, eviction rate, TTL-expiry synchronization spikes.
**Classic mistakes:** caching to hide a query that needed an index · no single-flight / request coalescing, so one hot key's expiry sends thousands of identical queries to the DB (cache stampede) · cache-aside written without thinking through the update race (read-modify-write vs invalidate-then-fill) · TTLs all set to the same round number so expiry synchronizes · caching data that is cheap to compute but expensive to keep coherent.
**Say no when:** writes are frequent relative to reads (coherence cost eats the benefit) · correctness requires read-your-own-writes and you cannot route those reads around the cache.
**Words:** hit rate, TTL, eviction (LRU/LFU), cache-aside, write-through, write-behind, invalidation, stampede / thundering herd, single-flight, negative caching, read-your-own-writes.

### CDN / edge caching

**Signal:** static or slowly-changing content served globally; origin bandwidth cost; latency dominated by geographic distance.
**One-liner:** cache at the network edge so bytes travel from a nearby node, not your origin.

```
user (Tokyo) ─> [edge Tokyo] ── hit: ~20ms
                     └── miss ─> [origin, Virginia]: ~200ms, then cached
```

**Get:** latency floor set by distance to the nearest edge node, not distance to the origin · origin offload, often >90% of bytes · absorbs traffic spikes and some attack traffic.
**Pay:** invalidation is slow and coarse (purges take time, propagate unevenly) · cache-control headers become production configuration · debugging "which node served this stale file" is painful.
**Invariant:** content is addressable by URL with correct cache headers. Content that varies per user or per auth token either bypasses the CDN or leaks between users — the classic CDN incident is caching a per-user response under a shared key.
**Alarms:** hit ratio per route, origin egress, purge latency, stale-served rate.
**Classic mistakes:** caching authenticated responses (data leak) · versionless asset URLs so a deploy needs a purge instead of a new hash · leaving the origin directly reachable, so attackers and crawlers bypass the edge entirely (allow-list origin traffic to the CDN) · forgetting that POST/cookies/Vary headers silently disable caching on a route.
**Say no when:** content is per-user and dynamic — you want application-level caching instead.
**Words:** edge, origin, purge/invalidation, cache key, Vary, immutable assets, content hashing, TTL, stale-while-revalidate.

### Rate limiting

**Signal:** one client can consume a disproportionate share; abuse or runaway retry loops; a downstream quota you must not exceed.
**One-liner:** refuse excess requests early and cheaply, per client, so one consumer cannot starve the rest.

```
requests ─> [limiter: tokens?] ── yes ─> serve
                     └── no ─> 429 + Retry-After   (cheap rejection beats expensive collapse)
```

**Get:** fairness between clients · protection from accidental self-DoS (retry storms, runaway scripts) · a contract you can publish (quotas).
**Pay:** legitimate bursts get clipped unless the algorithm allows them · distributed counting is its own small system · clients must handle 429 properly or they retry harder.
**Invariant:** rejection must be much cheaper than service. If the limiter does a DB lookup per request, it is load, not protection.
**Alarms:** rejection rate per client, limiter latency, top-N consumers, 429-then-immediate-retry rate (clients ignoring Retry-After).
**Classic mistakes:** limiting per node instead of per fleet, so limits multiply with autoscaling · fixed windows with edge bursts (2x limit straddling the boundary) · no Retry-After header, so well-behaved clients cannot behave well · doing expensive work before limiting — extract cheap identity (API key from header) before expensive verification (signature check, DB lookup), with a coarse per-IP layer in front of both; pure per-IP limiting false-positives behind corporate NATs.
**Say no when:** the problem is total capacity, not fairness — shedding load evenly needs load shedding, not per-client limits.
**Words:** token bucket, leaky bucket, sliding window, quota, burst allowance, 429, Retry-After, fairness, admission control.

### Backpressure and load shedding

**Signal:** under overload the system slows for everyone instead of failing cleanly for some; latency grows without bound before anything actually errors.
**One-liner:** when full, say no upstream (backpressure) or drop work deliberately (shedding) — because implicit queues (thread pools, socket accept backlogs, kernel buffers) will otherwise say no for you, catastrophically.

```
healthy:   in ──> [bounded buffer] ──> out        full? reject fast, upstream slows
unhealthy: in ──> [unbounded-ish buffers everywhere] ──> latency → ∞ → timeouts → retries → collapse
```

**Get:** graceful degradation — a fraction of users get fast errors instead of everyone getting timeouts · overload stays local instead of cascading · recovery is fast because there is no giant backlog to drain.
**Pay:** you must decide what to drop, which is a product decision wearing an engineering costume · bounded everything (pools, queues, inflight counts) takes deliberate configuration.
**Invariant:** every buffer is bounded and every bound has a defined full behavior. An unbounded queue is not the absence of a decision; it is deciding to fail by memory exhaustion and stale work.
**Alarms:** shed rate, buffer occupancy, latency vs throughput curve (throughput dropping while latency rises = congestion collapse in progress), goodput (completed useful work) vs raw throughput.
**Classic mistakes:** accepting every request and timing out on all of them instead of rejecting some fast (the system does maximum work for zero goodput) · shedding randomly instead of by priority (drop analytics before checkout) · retries without budgets turning 10% overload into 300% load · treating rising latency as a performance bug when it is a capacity signal.
**Say no when:** you have not measured actual capacity — bounds guessed too low shed load a healthy system could serve.
**Words:** backpressure, load shedding, goodput, admission control, bounded queue, congestion collapse, brownout, retry storm, priority shedding.

---

## Resilience

### Timeouts

**Signal:** a dependency sometimes hangs; threads/connections pile up waiting; one slow downstream freezes the whole request path.
**One-liner:** every remote call gets a deadline, because a hung call holds resources hostage and "slow" is contagious in a way "down" is not.

```
no timeout:   caller ──wait──────────────────────── (thread held, pool drains, caller dies too)
with timeout: caller ──wait──✂ 500ms → error → free the resource, degrade, move on
```

**Get:** bounded resource occupancy · failure detection (a hang becomes a signal) · the precondition for every other resilience pattern — retries and breakers need a definition of "failed".
**Pay:** a timeout is a guess; too short cancels work that would have succeeded, too long defends nothing · cancelled work may still complete downstream (see idempotency).
**Invariant:** timeouts shrink along the call chain. If A calls B calls C, A's budget must exceed B's, which must exceed C's — otherwise inner calls keep working for callers that already gave up. Propagate the remaining deadline, don't set each hop independently.
**Alarms:** timeout rate per dependency, latency histogram vs configured timeout (is the timeout inside the natural p99.9?), pool exhaustion.
**Classic mistakes:** library-default timeouts (infinite, or 30s where the caller's SLA is 1s) · one global timeout for calls with wildly different natural latencies · timeout without cancellation, so the work continues and the retry doubles the load · connect timeout confused with request timeout.
**Say no when:** never — every network call has a timeout. The only debate is the value.
**Words:** deadline propagation, deadline budget, cancellation, pool exhaustion, hedged requests, p99/p99.9, connect vs read timeout.

### Retries

**Signal:** transient failures (blips, restarts, packet loss) turn into user-visible errors that a second attempt would have absorbed.
**One-liner:** retry transient failures with exponential backoff and jitter, under a budget — retries convert blips into successes and overloads into outages, depending entirely on discipline.

```
attempt 1 ─fail─ wait 100ms±rand ── attempt 2 ─fail─ wait 200ms±rand ── attempt 3 ─fail─ give up
jitter matters: without it, every client that failed together retries together — synchronized waves.
```

**Get:** transparency over transient faults · higher success rate without human involvement.
**Pay:** amplified load exactly when the dependency is weakest · duplicated side effects unless calls are idempotent · added tail latency (the retried request is the slow one).
**Invariant:** the operation is idempotent, or the failure is provably pre-execution (connection refused). Retrying a timed-out payment call is how double charges happen — the timeout tells you nothing about whether the work ran.
**Alarms:** retry rate and retry success rate (retries that never succeed are pure load), retry share of total traffic to each dependency, budget exhaustion.
**Classic mistakes:** retrying at every layer (client 3x, gateway 3x, service 3x = 27 attempts) · no jitter, so backoff synchronizes clients into waves · retrying non-transient errors (400s, auth failures) · no retry budget, so at 50% dependency failure your outbound traffic doubles · immediate retry with no backoff.
**Say no when:** the call is not idempotent and you cannot make it so · the dependency is in sustained overload — retries there are a denial-of-service against your own infrastructure.
**Words:** exponential backoff, jitter, retry budget, retry storm, idempotency, transient vs permanent failure, work amplification, hedging.

### Idempotency

**Signal:** any retry, redelivery, or double-click anywhere in the system — which is to say, always. At-least-once delivery is the norm; exactly-once side effects must be built, not assumed.
**One-liner:** design operations so running them twice equals running them once; then duplicates, retries, and redeliveries become harmless instead of catastrophic.

```
client ── POST /charge {idempotency_key: K} ──> server: seen K? ── yes ─> return stored result
                                                        └── no ──> execute, store result under K
```

**Get:** retries and redeliveries become safe by construction · crash recovery simplifies enormously (just re-run) · the foundation queues, retries, and sagas silently assume.
**Pay:** a dedup store with lifetime management (how long do you remember keys?) · key discipline in every producer · "same request" needs a definition (same key with different payload = reject or first-wins?).
**Invariant:** check-and-execute is atomic. Checking "seen K?" and recording K in separate non-atomic steps means two concurrent duplicates both pass the check — the dedup itself has a race. Use unique constraints or atomic upserts, not read-then-write.
**Alarms:** duplicate-hit rate (how often keys repeat — proves the mechanism earns its keep), dedup store size, conflicting-payload-same-key rate.
**Classic mistakes:** "our messages are never duplicated" (they are; visibility timeouts, rebalances, and network partitions guarantee it) · idempotency in the handler but a non-idempotent side effect inside it (sends email, then crashes before recording the key) · key stored with a TTL shorter than the retry horizon · natural idempotency assumed for operations that only look idempotent (`SET balance = balance - 10` is not).
**Say no when:** never for money, messaging, or anything user-visible. For truly idempotent-by-nature operations (pure overwrite with full state) the key machinery is redundant — recognize, don't build.
**Words:** idempotency key, dedup window, at-least-once, exactly-once processing (vs delivery), natural idempotency, upsert, fencing token.

### Circuit breaker

**Signal:** a dependency is down and every request still pays the full timeout to find out; failures in one downstream cascade upstream through resource exhaustion.
**One-liner:** after enough consecutive failures, stop calling the dependency and fail fast; probe occasionally, and close again when it recovers.

```
CLOSED ──(failure rate > threshold)──> OPEN ──(cooldown)──> HALF-OPEN ──probe ok──> CLOSED
  │                                      │                       └─probe fails─> OPEN
  normal calls                     fail instantly, no call
```

**Get:** fast failure instead of timeout-priced failure · the sick dependency gets breathing room to recover · cascade prevention — the caller's pools stop draining.
**Pay:** another stateful component with tuning (thresholds, cooldowns) that is wrong until tuned by real incidents · a fallback path that must itself be designed and tested · in-process breakers have per-instance state (each node discovers the outage separately).
**Invariant:** there is a defined behavior for the open state — cached data, default value, degraded feature, or clean error. A breaker without a fallback plan just converts slow errors into fast errors (still valuable, but know that is all you bought).
**Alarms:** state transitions (an open breaker is an incident signal), open duration, fallback success rate, probe results.
**Classic mistakes:** breaker on the whole dependency instead of per-endpoint (one broken endpoint blacks out the healthy ones) · thresholds so tight that normal blips trip it, causing self-inflicted outages · fallback path never tested until the real outage, where it fails too · confusing breaker (stop calling the sick) with retry (persist against the blip) — they are opposites and must be tuned together.
**Say no when:** the dependency is in-process or the call is cheap-to-fail already · call volume is so low that the tuning burden outweighs the benefit. (A timeout is not a substitute: it still holds a resource for the full window and still lands load on the sick dependency; an open breaker frees the caller instantly and sends zero traffic.)
**Words:** open/closed/half-open, failure threshold, probe, fallback, fail fast, cascade, bulkhead (its sibling).

### Bulkhead

**Signal:** one misbehaving dependency or tenant exhausts a shared resource (thread pool, connection pool) and takes unrelated features down with it.
**One-liner:** partition resources per dependency or tenant so one failure fills its own compartment and stops there — the ship-hull metaphor, literally.

```
shared pool:      [■■■■■■■■■■] ← slow dep eats all threads; everything drowns
bulkheaded:       [■■■|··|··]  ← slow dep fills its slice; other features unaffected
```

**Get:** blast-radius control · noisy-neighbor isolation · overload in feature A is invisible to feature B.
**Pay:** partitioned resources are less efficient than pooled ones (idle capacity in one compartment cannot help another) · more configuration surface · sizing per compartment needs real traffic knowledge.
**Invariant:** nothing that matters is shared across compartments. Bulkheads over a shared database pool, event loop, or GC heap are isolation theater — the pattern silently becomes a no-op while everyone believes the blast radius is contained.
**Alarms:** per-compartment saturation and rejection rate, cross-compartment correlation of failures (if compartments fail together, something is still shared — often the event loop, DB, or GC).
**Classic mistakes:** bulkheads in the app while all compartments share one database pool underneath · compartments sized by guess — too small starves a healthy feature, one sized for the worst case of everything defeats the point; size from measured per-dependency demand · forgetting the truly shared substrate: CPU, memory, GC pauses cross all bulkheads.
**Say no when:** a single dependency dominates the service (partitioning one thing is a rename) · utilization efficiency matters more than isolation, e.g. batch systems.
**Words:** blast radius, noisy neighbor, resource isolation, pool partitioning, tenant isolation, cell-based architecture (bulkheads at datacenter scale).

### Distributed locks and leases

**Signal:** "we'll just take a lock in Redis" — several nodes must not run the same critical section: a cron job on N instances, one writer per resource, a singleton migration.
**One-liner:** a distributed lock is really a lease — a lock with an expiry, mandatory because holders die without unlocking — and expiry means two holders is possible; fencing tokens make that survivable.

```
A acquires lease (token 33) ── GC pause... lease expires ── B acquires (token 34)
A wakes, still believes it holds the lock ── writes with token 33 ──> storage rejects: 33 < 34
without fencing: A and B both write. the lock "worked" and the data is corrupt anyway.
```

**Get:** mutual exclusion across nodes · single-writer semantics · scheduled work runs once, not N times.
**Pay:** expiry tuning (too short: false takeovers mid-work; too long: slow recovery after a real death) · the lock store becomes a coordination dependency on every protected path · real safety needs the protected resource to check fencing tokens, and many resources cannot.
**Invariant:** safety never rests on the lease alone. Clock skew, GC pauses, and network delay mean an expired holder can still act while believing it holds the lock. Either the downstream resource enforces fencing (a monotonic token checked at write time), or the operation is idempotent so a duplicate run is harmless.
**Alarms:** hold time vs lease duration (holds approaching the lease are takeovers waiting to happen), takeover rate, fencing rejection rate, lock-store availability.
**Classic mistakes:** lock with no expiry, so a dead holder deadlocks everyone forever · expiry but no fencing — the GC-pause double-writer above · work that outlives the lease with no renewal heartbeat · a lock where idempotency would have been simpler and safer · treating a single-node lock store as consensus-grade coordination.
**Say no when:** the operation can be made idempotent — let duplicates race and dedup at the write · one database holds the data anyway — unique constraints, conditional updates, or `SELECT ... FOR UPDATE` beat a separate lock service every time.
**Words:** lease, TTL, fencing token, heartbeat/renewal, mutual exclusion, leader election, split brain, lock store, idempotent fallback.

---

## Data

### Replication

**Signal:** read load exceeds one machine; a single disk failure would lose data; you need reads closer to users or survivable failover.
**One-liner:** keep copies of the data on multiple nodes — writes go to a leader, copies follow, reads can fan out.

```
writes ─> [primary] ──replication──> [replica 1] <─ reads
                └──────────────────> [replica 2] <─ reads
replication lag: the replica is the recent past, not the present.
```

**Get:** read scaling · durability (a dead disk is not data loss) · failover target · geographic read locality.
**Pay:** replication lag — replicas serve the past · failover is a hard problem, not a checkbox (split brain, lost writes) · async replication means an acknowledged write can die with the primary.
**Invariant:** every read path states its staleness tolerance. Reads that must see the writer's own writes go to the primary (or wait for the replica to catch up); routing them to replicas "for load" produces the classic bug — user saves, refreshes, sees old data.
**Alarms:** replication lag (seconds and bytes), failover time in drills (not in theory), replica read/error skew.
**Classic mistakes:** read-your-own-writes violations after pointing reads at replicas · treating failover as automatic-and-safe without fencing the old primary (fencing: guaranteeing the demoted node can no longer accept writes; without it, split brain — two nodes accepting writes) · sync replication everywhere for durability, then discovering every write now costs a cross-node round trip · backups replaced by replication (replication faithfully replicates your DELETE).
**Say no when:** the workload is write-bound — replicas do not absorb writes; that is sharding's job.
**Words:** leader/follower, replication lag, sync vs async replication, failover, split brain, fencing, quorum, read-your-own-writes, RPO/RTO.

### Sharding / partitioning

**Signal:** the write load or data volume exceeds what one primary can hold, and vertical scaling has run out of runway.
**One-liner:** split the data by a key across independent nodes so each holds a slice — the scaling move of last resort, taken when you must, not when it is cool.

```
key ──hash/range──> shard 1 [users A–H]   each shard: its own primary, its own replicas
                    shard 2 [users I–P]   cross-shard query = scatter-gather = pain
                    shard 3 [users Q–Z]
```

**Get:** write scaling and storage scaling beyond one machine · failure isolation per shard.
**Pay:** cross-shard queries, joins, and transactions range from expensive to unavailable · resharding live data is a project measured in quarters · hot keys concentrate load no matter how you split · operational surface multiplies by shard count.
**Invariant:** the shard key matches the dominant access pattern. Almost every query should resolve to one shard from the key alone; a workload that constantly crosses shards has the wrong key — or should not be sharded.
**Alarms:** per-shard load skew (hot shards), cross-shard query rate, shard size divergence, scatter-gather latency (tail of the slowest shard).
**Classic mistakes:** shard key chosen from the data model instead of the query pattern · monotonic keys (auto-increment, timestamps) sending all inserts to one shard · celebrity/hot-key problem discovered in production · sharding before exhausting the boring options: bigger box, read replicas, caching, deleting data, fixing queries.
**Say no when:** one well-tuned primary plus replicas still fits — most systems live and die below the sharding threshold, and the complexity is permanent.
**Words:** shard key / partition key, hash vs range partitioning, resharding, hot key, scatter-gather, consistent hashing, cross-shard transaction, celebrity problem.

### Consistency models

**Signal:** any system with more than one copy of data — replicas, caches, queues, services with their own stores. The question is never whether you have a consistency model; it is whether you know which one.
**One-liner:** consistency is a per-operation contract about what reads may see; the spectrum runs from linearizable (as if one copy) to eventual (converges someday), and each step down buys lower latency and higher availability.

```
strong / linearizable:  write ──ack──> every subsequent read sees it     (coordination: pay per op)
eventual:               write ──ack──> reads converge... eventually      (fast, available, briefly wrong)
in between: read-your-writes, monotonic reads, causal — often what users actually need
```

**Get (weakening):** lower latency, higher availability, partition tolerance in practice.
**Pay (weakening):** anomalies — stale reads, out-of-order observations, lost-update races — each of which becomes an application-level bug you must design around or accept.
**Invariant:** consistency is chosen per operation, not per system. A checkout and a view counter do not want the same contract; declaring one model for the whole architecture guarantees it is wrong somewhere.
**Alarms:** staleness distribution where measurable, anomaly reports of the "I saved it and it vanished" shape, conflict rate on concurrent writes.
**Classic mistakes:** CAP quoted as "pick 2 of 3" (during a partition you choose consistency or availability; when there is no partition, the trade is latency vs consistency — PACELC, expanded under Common misunderstandings) · "eventually consistent" used to mean "roughly consistent" (it means arbitrarily stale with convergence, no bound unless you build one) · session guarantees like read-your-own-writes forgotten, producing bugs users can see and screenshot · assuming a database's default gives strong consistency (defaults are often weaker than you think).
**Say no when:** n/a — this card is not optional; every multi-copy system has already chosen a model, possibly by accident.
**Words:** linearizability, eventual consistency, causal consistency, read-your-own-writes, monotonic reads, CAP, PACELC, quorum, staleness, anomaly, conflict resolution.

### Distributed transactions and sagas

**Signal:** one business operation must update data in two systems that do not share a transaction — two services, a DB and a payment provider, two shards.
**One-liner:** you cannot get one atomic commit across independent systems at reasonable cost; a saga replaces it with a sequence of local transactions plus a compensating action for each, run forward or unwound on failure.

```
order saga:  reserve stock ─> charge card ─> create shipment ─> done
                  │                │              fails here
                  │                └── compensate: refund
                  └──────────────── compensate: release stock
each step: local, committed, visible. compensation ≠ rollback: the world saw the intermediate state.
```

**Get:** cross-system workflows without distributed locking or a 2PC coordinator that blocks everyone when it dies · each step is a plain local transaction.
**Pay:** intermediate states are visible to the rest of the system (no isolation) · compensations are business logic someone must design — "un-send an email" has no clean inverse · the saga itself needs durable state and a driver (orchestrator or event choreography).
**Invariant:** every step has a defined compensation or the sequence is ordered so non-compensatable steps come last. A saga with an irreversible step in the middle is a machine for manufacturing inconsistent states.
**Alarms:** stuck sagas (age of oldest incomplete), compensation rate, compensation failure rate (the truly bad day), manual-intervention queue depth.
**Classic mistakes:** reaching for 2PC because it "guarantees" atomicity, then meeting its availability profile (coordinator down = everyone blocked) · compensations designed as afterthoughts and never tested · assuming compensation restores the original state (it creates a new correcting state; the intermediate one happened and was observed) · no timeout on saga steps, so a stuck saga holds reservations forever.
**Say no when:** the data can live in one database — a single ACID transaction beats any saga; do not distribute what you can co-locate.
**Words:** saga, compensating transaction, orchestration vs choreography, two-phase commit (2PC), semantic lock, pivot step, eventual consistency, process manager.

### Outbox pattern

**Signal:** a service must write to its database and publish an event, and both must happen — dual-write, the bug factory: DB commits then publish fails (or reverse), and the two worlds diverge.
**One-liner:** write the event into an outbox table inside the same DB transaction as the business change; a relay reads the table and publishes — one atomic decision, delivery deferred.

```
tx { UPDATE orders...; INSERT INTO outbox(event) }  ← one commit, both or neither
        outbox ──[relay/CDC]──> broker ──> consumers   (at-least-once ⇒ consumers dedup)
```

**Get:** atomicity between state change and event emission, using only the local transaction you already have · a durable, replayable event log as a bonus.
**Pay:** publish latency (relay polling or CDC lag) · relay is a component to run and monitor · delivery is at-least-once, so consumers must be idempotent (see that card).
**Invariant:** the outbox insert is inside the business transaction. Written outside it — even one line after commit — the pattern is dual-write again with extra steps.
**Alarms:** outbox depth and oldest-unpublished age, relay lag, publish failure rate.
**Classic mistakes:** skipping the outbox because "the broker is reliable" (the broker is; the network between your commit and your publish call is not the same atomicity domain) · relay publishes then crashes before marking published — duplicate on restart, which is fine if consumers dedup and a bug factory if not · outbox table growing forever with no pruning · ordering assumptions across aggregates (order holds per-key at best).
**Say no when:** state and event genuinely do not need atomicity (a lost analytics event is fine) · the infrastructure has real transactional publish across the exact resources in play.
**Words:** dual-write problem, transactional outbox, change data capture (CDC), relay, at-least-once, event log, log tailing.

### Event sourcing

**Signal:** the history of changes is itself a business requirement — audit, temporal queries ("what did it look like on the 3rd?"), replay, ledgers.
**One-liner:** store the events that happened, not the current state; state is a fold over the log, computed or cached as snapshots.

```
events:  [Opened] [Deposited 100] [Withdrew 30] [Deposited 5]   ← the truth, append-only
state:   fold(events) = balance 75                              ← derived, rebuildable
```

**Get:** perfect audit trail by construction · time travel and replay · new read models derivable from history retroactively · append-only writes are fast and conflict-light.
**Pay:** querying current state needs projections (and usually CQRS, next card) · schema evolution of immutable events is genuinely hard (old events never go away) · everyone touching the system must think in events · mistakes are corrected by compensating events, not edits.
**Invariant:** events are immutable facts, named in past tense, and never rewritten. The moment someone "fixes" a stored event, the log stops being a log and every derived view is suspect.
**Alarms:** projection lag, replay duration (rebuild time grows with history — snapshots bound it), event schema version spread.
**Classic mistakes:** event-sourcing the whole system when one aggregate (the ledger, the order) needed it · events that are just CRUD in costume ("UserUpdated {entire row}") carrying no intent · no snapshotting, so rebuilds take hours · no upcasting strategy, so v1 events break v3 code · GDPR/erasure discovered after the immutable log ships (plan crypto-shredding or PII segregation up front).
**Say no when:** you only need an audit trail — an append-only audit table beside normal state is a tenth of the cost · the domain is genuinely CRUD.
**Words:** event log, fold/reduce, projection, snapshot, replay, upcasting, aggregate, compensating event, crypto-shredding, temporal query.

### CQRS

**Signal:** read and write needs have diverged — writes want normalized integrity, reads want denormalized speed and shapes the write model cannot serve without contortions.
**One-liner:** separate the write model from the read model(s), each shaped for its job, with reads updated from write-side changes — usually eventually.

```
commands ─> [write model, normalized] ──events/CDC──> [read model(s), denormalized] ─> queries
                                                        (search index, list view, report cube)
```

**Get:** each side optimized independently (integrity vs query speed) · read models multiply cheaply (add a search index without touching the write path) · read and write scale independently.
**Pay:** eventual consistency between the models — the UI may not immediately show what the user just did (design for it: optimistic UI, or read-your-writes on critical paths) · projection code is a new class of logic with a new class of bugs · two models to migrate instead of one.
**Invariant:** the write model is the source of truth and read models are disposable — rebuildable from the write side at any time. A read model that cannot be rebuilt is a second source of truth, and now you have two.
**Alarms:** projection lag, read/write model divergence checks, rebuild duration.
**Classic mistakes:** CQRS applied system-wide as an architecture religion instead of per-hot-spot · treating it as inseparable from event sourcing (they pair well but either stands alone) · user saves then immediately queries the stale read model — the bug every CQRS system ships once · projection failures silently accumulating divergence.
**Say no when:** one model serves both sides fine — most CRUD apps. CQRS is a response to measured divergence pressure, not a default.
**Words:** command/query, read model, projection, denormalization, eventual consistency, materialized view, rebuild, optimistic UI.

### Optimistic vs pessimistic concurrency

**Signal:** concurrent writers can touch the same row/document; lost updates (last-write-wins clobbering) or lock contention is appearing.
**One-liner:** pessimistic locks the record while you work (conflicts prevented, throughput pays); optimistic lets everyone try and rejects stale writes at commit via a version check (throughput wins, conflicts retry).

```
pessimistic: A locks ── works ── commits ── unlocks     B waits...
optimistic:  A reads v7 ── writes if still v7 → v8      B reads v7 ── writes if v7 → conflict, re-read, retry
```

**Get (optimistic):** no locks held across user think-time or network calls · reads never block · scales with low contention.
**Pay (optimistic):** conflict handling is mandatory application logic (retry, merge, or surface to the user) · under high contention, retry rate climbs until pessimistic would have been faster.
**Invariant:** the version check and the write are one atomic operation (`UPDATE ... WHERE id = ? AND version = ?`, affected-rows = 1). Read-check-then-write as separate steps re-creates the race you were preventing.
**Alarms:** conflict/retry rate (optimistic), lock wait time and deadlock rate (pessimistic), retry-give-up rate.
**Classic mistakes:** no concurrency control at all — last write silently wins and users lose edits (the default in most ORMs until you turn versioning on) · optimistic conflicts thrown at users as raw errors instead of retried or merged · pessimistic locks held across HTTP calls or user think-time, serializing the system · choosing by ideology instead of contention rate: low contention → optimistic, hot rows → pessimistic or redesign the hot row away.
**Say no when:** writers never overlap (single-writer designs) — versioning machinery with no race to prevent.
**Words:** lost update, version column / ETag, compare-and-swap, lock contention, deadlock, contention rate, last-write-wins, conditional update.

---

## Communication and structure

### Sync vs async communication

**Signal:** every inter-service call is a blocking HTTP call because that was the default, and availability is coupling: each hop multiplies failure probability and adds latency.
**One-liner:** sync couples availability and latency for an immediate answer; async decouples both at the price of "the answer arrives later, somewhere else."

```
sync:   A ──req──> B ──req──> C        A's availability ≈ A·B·C; A's latency ≥ B+C
async:  A ──event──> [broker] ──> B, C   A unaffected by B's death; but where's the reply?
```

**Get (async):** availability decoupling (B down ≠ A down) · burst absorption · fan-out to N consumers without N calls in A.
**Pay (async):** correlation of request to response is now your problem · debugging spans a broker and time (invest in tracing and correlation IDs) · ordering and duplicate handling (see idempotency) · eventual consistency by default.
**Invariant:** the decision follows the "who waits?" question — it decides who needs a completion signal and how soon. Human waiting + short bounded work → sync. Human waiting + long or unreliable work → async job with a progress/completion channel (the export, the report, the bulk import). Nobody waits → async, no matter how convenient a blocking call feels.
**Alarms:** (sync) per-hop latency and error budgets, depth of call chains; (async) end-to-end completion time, in-flight age.
**Classic mistakes:** chains of sync calls five services deep — the availability math (0.999⁵) nobody ran · async everywhere, then request-reply reimplemented badly on top of the broker · sync call inside a message handler, importing sync's coupling into the async world · no correlation IDs, making cross-service debugging archaeology.
**Say no when:** n/a — this is a per-edge decision; the mistake is defaulting the whole system to either.
**Words:** temporal coupling, availability coupling, request-reply, fire-and-forget, correlation ID, fan-out, choreography, latency budget.

### Pub/sub

**Signal:** one event interests several consumers, and the producer keeps growing a list of "also notify X" calls; teams block on each other to add downstream behavior.
**One-liner:** producers publish events to a topic without knowing the consumers; consumers subscribe without the producer changing — organizational decoupling as infrastructure.

```
order-service ──"OrderPlaced"──> [topic] ─┬─> email service
                                          ├─> analytics
                                          └─> fraud check    ← added later; producer untouched
```

**Get:** new consumers with zero producer changes · team decoupling (the consumer's deploy is not the producer's problem) · natural fan-out.
**Pay:** the event schema is now a public API with all the compatibility duties of one · nobody sees the whole flow — "what happens when an order is placed?" requires tracing, not reading · at-least-once + per-consumer failure means partial processing states.
**Invariant:** events carry facts about what happened, not instructions about what to do. "OrderPlaced" scales to unknown consumers; "SendConfirmationEmail" is a remote procedure call wearing an event costume, and it re-couples the producer to one consumer's job.
**Alarms:** per-subscription lag and DLQ rate (each consumer fails independently), schema version spread across consumers, orphaned topics.
**Classic mistakes:** breaking the event schema because "it's just an event" (consumers you have never met break at 2am) · commands disguised as events · assuming all consumers processed an event because one did · event chains forming undocumented workflows nobody can draw — at some length, an explicit orchestrator is honest and choreography is denial.
**Say no when:** exactly one consumer exists and ever will · the producer needs the consumer's result — that is request-reply; use it.
**Words:** topic, subscription, fan-out, event vs command, schema evolution / registry, consumer group, choreography vs orchestration, dead-letter queue.

### API gateway and BFF

**Signal:** every client talks to every service directly — auth, rate limiting, and TLS reimplemented per service; clients orchestrate multi-service calls over the public internet; mobile and web fight over one general-purpose API.
**One-liner:** one front door for cross-cutting concerns (gateway); optionally one tailored door per client type (backend-for-frontend) so each UI gets the shape it needs.

```
mobile ─> [BFF mobile] ─┐
web    ─> [BFF web]    ─┼─> [gateway: auth, limits, routing] ─> services
partner─> [public API] ─┘
```

**Get:** auth/limits/TLS/observability solved once · internal topology hidden from clients (services move without client churn) · per-client response shaping instead of chatty generic APIs.
**Pay:** a hop on every request's latency · potential single point of failure and, worse, single point of deployment coordination · BFFs multiply per client type and someone owns each.
**Invariant:** the gateway stays thin — routing and cross-cutting policy, not business logic. Business rules in the gateway rebuild the monolith at the most contended, most shared spot in the system.
**Alarms:** gateway latency overhead (own it as a budget line), gateway error vs upstream error split, config/route drift.
**Classic mistakes:** gateway grows business logic and becomes the bottleneck team · one "general" API serving mobile, web, and partners equally badly (the problem BFF exists to solve) · BFF-per-team instead of BFF-per-client-experience · gateway deploys becoming everyone's coordination point.
**Say no when:** one or two services and one client — a gateway is ceremony; add it when the cross-cutting duplication actually appears.
**Words:** API gateway, backend-for-frontend (BFF), cross-cutting concerns, edge, north-south vs east-west traffic, response shaping, TLS termination.

### Monolith vs microservices

**Signal:** teams block on each other's deploys and a shared codebase's build/test cycle; or conversely — a service mesh of 40 microservices maintained by 6 engineers.
**One-liner:** microservices trade in-process simplicity for independent deployability — an organizational scaling tool that charges distributed-systems prices; pay only when team contention actually hurts.

```
monolith:      [ one deployable ]           call = function call. tx = ACID. debugging = one stack trace.
microservices: [A] [B] [C] [D]...           call = network (timeouts, retries). tx = saga. debugging = tracing.
                every card above this one: now mandatory reading.
```

**Get:** independent deploys per team · independent scaling per hotspot · failure isolation (with the resilience patterns above actually applied) · tech freedom per service (a mixed blessing).
**Pay:** every in-process certainty becomes a distributed problem — function call to network call, ACID to saga, stack trace to distributed trace · operational surface multiplies · cross-service refactors that were one IDE rename become multi-team projects.
**Invariant:** service boundaries follow team and domain boundaries (Conway's law — systems copy the communication structure of the org that builds them — is a force of nature; align with it or lose to it). Services split by technical layer or by noun-storming produce a distributed monolith: all the coupling, plus network in between.
**Alarms:** cross-service change frequency (features routinely touching 3+ services = wrong boundaries), deploy coupling (services that must ship together), per-service ownership gaps.
**Classic mistakes:** microservices adopted for scale when the actual pressure was one team's deploy queue — traffic scale is mostly solved by the load section above, inside a monolith · splitting before domain boundaries are understood (the monolith is where you learn them) · the distributed monolith: shared database, synchronized deploys, chatty sync calls · counting services as progress.
**Say no when:** one team, or boundaries still unknown — a well-modularized monolith (enforced module boundaries, one deployable) captures most benefits at a fraction of the cost, and extracts cleanly later.
**Words:** independent deployability, bounded context, Conway's law, distributed monolith, modular monolith, service ownership, east-west traffic, distributed tracing.

### Strangler fig

**Signal:** a legacy system needs replacing, and the instinct in the room is a big-bang rewrite with a cutover date — history's least survivable project shape.
**One-liner:** put a routing facade in front of the legacy system and move functionality out slice by slice; each slice ships to production, and the old system dies by starvation, not by cutover.

```
            [facade/router]
clients ──>   ├─ /orders   ──> new service      ← migrated, in production, earning feedback
              └─ /*        ──> legacy           ← shrinking
migration state lives in the router. rollback = flip a route.
```

**Get:** incremental risk — each slice is small, shippable, reversible by route flip · value and learning from month one instead of after a two-year rewrite · no frozen-world assumption (the legacy keeps running and changing underneath).
**Pay:** facade plus double-run operation for the whole migration (which will outlive its schedule) · data synchronization between old and new during the overlap is the genuinely hard part · a long middle period where the system is two systems.
**Invariant:** there is a routing seam through which all traffic already flows (or one is built first), and every migrated slice fully owns its writes — a slice whose data still round-trips through legacy tables is not migrated, it is entangled.
**Alarms:** traffic share new-vs-legacy over time (a stalled ratio is a stalled migration), divergence checks during dual-run/shadow phases, migration age.
**Classic mistakes:** the last 20% of routes living on legacy forever because the easy slices went first and nobody budgeted the hard ones · no comparison/shadow phase, so the new path's differences are discovered by users · slicing by technical layer instead of business capability (a slice should be a feature someone can verify) · declaring victory while legacy still handles writes for "migrated" data.
**Say no when:** the system is small enough to rewrite inside one release cycle · no seam exists and the coupling is so total that building the facade costs more than the rewrite.
**Words:** strangler fig, facade, seam, incremental migration, dual-run / shadow traffic, dark launch, cutover, feature parity trap.

---

## Common misunderstandings

Claims heard in real meetings, and what is actually true.

- **"The queue will fix our overload."** A queue absorbs bursts around a sustainable
  average. If average inflow exceeds drain rate, the backlog grows forever — the queue
  converts a fast, visible failure into a slow, stale, confusing one. Capacity — or
  deliberate shedding — fixes overload; queues fix variance.
- **"We need exactly-once delivery."** Between systems you get at-least-once or
  at-most-once from the transport; exactly-once *processing* is built on top with
  idempotent consumers and dedup. Vendors advertising exactly-once mean "we built that
  layer inside our walls" — the moment a side effect leaves those walls, it is yours to build.
- **"CAP: pick two of three."** Partition tolerance is not optional on a real network.
  The choice is: during a partition, consistency or availability; the rest of the time,
  latency versus consistency (PACELC). "We picked CA" describes a system that has not
  met its first partition yet.
- **"Eventually consistent — so, consistent."** Eventual consistency promises
  convergence with no bound on when. Any bound ("within 5 seconds") is a property you
  must build and measure, not one the phrase grants.
- **"Add servers and it scales."** Only work with no shared state and no coordination
  scales linearly. Contention (the shared DB, the lock, the leader) caps speedup —
  Amdahl's law — and coordination overhead (cross-talk between nodes) can make adding
  nodes reduce throughput — the Universal Scalability Law's retrograde region. Find the
  serial fraction before buying machines.
- **"Microservices will make it scale."** Microservices scale organizations —
  independent team deploys. Traffic scale comes from the load section: statelessness,
  caching, replication, partitioning — all available inside a monolith. Adopting the
  distributed-systems tax to fix a throughput problem is paying the wrong bill.
- **"We'll cache it" (about a slow query).** A missing index hidden behind a cache is
  still missing; now it has staleness, invalidation, and a stampede failure mode
  stapled on. Fix the query first; cache what is expensive *after* it is efficient.
- **"Retries make it more reliable."** Retries with backoff, jitter, budgets, and
  idempotency absorb blips. Retries without them are a load amplifier wired to trigger
  at the worst moment — they turn a dependency's bad minute into everyone's outage.
- **"It works on my machine / the network is reliable."** The eight fallacies of
  distributed computing (reliable network, zero latency, infinite bandwidth, secure
  network, fixed topology, one admin, zero transport cost, homogeneous network) are a
  checklist of assumptions that each become an outage. Design as if each is false,
  because each is.
- **"Two nines, three nines — details."** Each nine is 10x: 99.9% is ~8.8 hours down
  per year; 99.99% is ~53 minutes. And chained sync dependencies multiply: five
  three-nines services in a row give ~99.5%. Availability math is multiplication,
  not vibes.
- **"The p50 looks great."** Users experience the tail, and fan-out samples the tail:
  a page touching 100 backends where each has a 1% slow tail makes ~63% of pages slow
  (1 − 0.99¹⁰⁰). At scale, tail latency is the latency.
- **"We'll make it consistent later."** Consistency retrofits onto shipped data models
  the way foundations retrofit under built houses. Decide the contract per operation
  now, even if the decision is "eventual, and here is the anomaly we accept."

---

## How to sound precise in the room

Not phrases to perform — distinctions that change decisions.

- **Name the axis of the trade.** Patterns trade along recurring axes: latency vs
  consistency, throughput vs isolation, coupling vs autonomy, simplicity vs blast
  radius. "A queue trades latency variance for burst absorption" moves a meeting;
  "queues are more scalable" does not.
- **Say the invariant, not the technology.** "We need reads to reflect the user's own
  writes" leads somewhere; "we should use Redis" is a conclusion missing its argument.
- **Ask for the number.** Peak RPS, p99 today, data size in two years. Most
  architecture debates dissolve on contact with the actual number — usually because it
  is 100x smaller than the pattern being proposed assumes.
- **Separate the failure conversation from the happy-path conversation.** "How does
  this behave when the broker is down / the region fails / the queue is 2 hours deep?"
  is where designs are actually decided.
- **State the reversal cost.** "If this is wrong, we change a config" and "if this is
  wrong, we re-migrate the data" deserve different amounts of meeting.
- **Little's Law, availability multiplication, tail-at-scale** — the three pieces of
  math that settle arguments: L = λW sizes anything with a queue; 0.999ⁿ prices a call
  chain; 1 − (1−p)ⁿ prices a fan-out's tail.

---

## Resources

- **Designing Data-Intensive Applications** — Kleppmann. The data half of this file,
  with proofs. Replication, partitioning, transactions, consistency.
- **Release It!** (2nd ed) — Nygard. The resilience half: circuit breakers, bulkheads,
  and the production failure stories that motivated them.
- **The Amazon Builders' Library** (aws.amazon.com/builders-library) — timeouts,
  retries, jitter, shedding, cell architecture, written by people with the scars.
- **Site Reliability Engineering** (sre.google/books, free) — the Google book on
  running systems: SLOs, error budgets, overload, cascading failures.
- **The Tail at Scale** — Dean & Barroso, CACM 2013. Why p99 rules fan-out systems.
- **Patterns of Distributed Systems** — Joshi (hosted on martinfowler.com). Named
  building blocks: write-ahead log, quorum, leader election, fencing.
- **microservices.io** — Richardson. Saga, outbox, CQRS, strangler — the catalog with
  diagrams.
- **Jepsen analyses** (jepsen.io) — what consistency guarantees databases actually
  keep under partition, tested. Sobering and precise.
