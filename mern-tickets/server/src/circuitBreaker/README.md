# Circuit breaker

## What this is

A pure, in-memory, per-process state machine (`createCircuitBreaker`) that wraps a call to something unreliable — here, an outbound webhook — and stops the app from making calls it can already tell will fail. It has three states: **closed** (calls pass through and are counted), **open** (calls are rejected immediately, without ever touching the wrapped function), and **half-open** (a small number of trial calls decide whether to close again or re-open). `src/notifier/webhook.js` is the one thing in this app that uses it: a POST to `TICKET_WEBHOOK_URL` on ticket creation and on every status change, fired-and-forgotten from `src/services/tickets.js` so a dead or slow webhook can never fail or slow a ticket write.

## How it works here

`createCircuitBreaker` (`src/circuitBreaker/breaker.js:15`) closes over its own state — `state`, `openedAt`, an `outcomes` array, and the half-open bookkeeping (`src/circuitBreaker/breaker.js:25-29`) — and returns three things: `call(fn)`, a `state` getter, and `stats()`. There is no background timer anywhere in this file. Every transition is evaluated lazily, at the top of `call()`, the same trick `src/throttle/tokenBucket.js` uses for lazy refill: `evaluate(t)` (`src/circuitBreaker/breaker.js:47-49`) checks whether `openMs` has elapsed since `openedAt` and flips `open` to `half-open` right there, on the next call that happens to arrive — not a moment sooner, because nothing is watching the clock in between.

`call(fn)` (`src/circuitBreaker/breaker.js:69-85`) takes a single timestamp `t = now()` and branches on the current state. If `open`, it throws a `CircuitBreakerOpenError` (`src/circuitBreaker/breaker.js:1-9`) before `fn` is ever referenced again — that immediacy is the entire point of tripping a breaker: a caller in `open` pays microseconds, not the timeout of the call it would have made. If `half-open`, it checks `halfOpenInFlight` against `halfOpenMaxCalls` (default 1) and rejects the same way if a trial is already in flight; otherwise it lets exactly one (by default) trial through. Every other call — `closed`, or an admitted `half-open` trial — runs `fn`, then calls `record(success, now())` (`src/circuitBreaker/breaker.js:53-68`) with the outcome. `record` first prunes the rolling window (`pruneWindow`, `src/circuitBreaker/breaker.js:50-52`, evicting anything older than `windowMs`), pushes the new outcome, and only then asks: in `closed`, have we seen at least `minimumThroughput` calls, and is the failure rate over `failureRateThreshold`? If both, `transition(OPEN, t)`. In `half-open`, a single failure re-opens immediately and restarts `openedAt`; a success (repeated until `successesToClose`, default 1) closes the breaker and — because `transition` clears `outcomes` on entering `closed` (`src/circuitBreaker/breaker.js:44`) — wipes the window clean, so the dependency gets a fresh reputation rather than carrying an old failure count forward.

What counts as a failure is not the breaker's decision — `isFailure(err)` (`src/circuitBreaker/breaker.js:23`, defaulting to "any throw is a failure") is passed in by the caller, because only the caller knows its own protocol. `src/notifier/webhook.js:12-17` is where that choice actually gets made for this app: `isWebhookFailure` treats a timeout or a 5xx as a failure, treats 408 and 429 as a failure (the upstream is telling you to slow down or that it was too slow, which is exactly what a breaker exists to react to), and treats every other 4xx as *not* a failure — a malformed webhook payload is a bug in this app, not evidence the upstream is unhealthy.

`createNotifier` (`src/notifier/webhook.js:23-52`) builds one `post()` that calls `fetch` with `signal: AbortSignal.timeout(timeoutMs)` (default 1000ms, `src/notifier/webhook.js:3,27-32`) and throws a `WebhookResponseError` carrying the status on any non-2xx response, and one `notify()` that is a no-op when no URL is configured (`src/notifier/webhook.js:37-38`) and otherwise calls `breaker.call(() => post(url, event))` inside a `try/catch` that swallows and logs everything (`src/notifier/webhook.js:39-43`) — `notify()` never rejects, by construction, which is what makes it safe to call without `await`. The module builds exactly one such notifier at load time (`src/notifier/webhook.js:54`) and exports its `notify`/`stats` as the app-wide singleton — "one breaker per dependency, per process." `createNotifier` is also exported so tests can build an isolated instance with an injected `now`, a fake `url`, and a short `timeoutMs`, without touching `process.env` or waiting on real timers (`test/notifier.test.js`). `src/services/tickets.js:10,54,87` is the only caller of the singleton: `create()` and `transitionStatus()` each call `notify(...)` after the write is already durable, without `await`, exactly the fail-open call `src/hooks/README.md` describes for moderation — except here there isn't even a synchronous window where a slow webhook could stall the response, because the call is never on the request's critical path at all.

A rejection while `open` carries `state`, `retryAfterMs`, and a `status` of 503 (`src/circuitBreaker/breaker.js:4-7`); the shared `errorHandler` (`src/middleware/error.js:41-44`) maps any 503 the same way it already mapped 429 — status code plus a `Retry-After` header. Nothing in this app currently lets that error reach a response (the notifier swallows it), so this mapping exists for the *next* caller of this breaker that isn't fire-and-forget, and is covered directly in `test/circuitBreaker.test.js`.

## The core concepts

- **Why the three states, and why half-open exists at all.** `closed` and `open` alone give you a breaker that either hammers a dead dependency forever or, once it decides to recover, lets every queued request through in the same instant it flips back — a thundering herd that can re-kill the thing that was just recovering. `half-open` is the fix: it lets through a controlled trickle (`halfOpenMaxCalls`, default 1) to ask "is it actually better now?" before committing the whole app to finding out. The alternative to half-open is a human watching a dashboard and flipping the breaker back on by hand, which is not a design you want to depend on at 3am.
- **Error rate over a rolling window with a minimum throughput, not a consecutive-failure counter.** A counter that trips after N failures in a row treats "3 unlucky calls in a row on a system doing 10,000 requests/minute" and "3 failures out of 4 total requests" identically, which is backwards — the second is a real outage and the first is noise. Rate-over-window fixes the numerator problem; `minimumThroughput` fixes the denominator problem it would otherwise create: without it, a low-traffic endpoint that sees exactly one request in a quiet hour trips at 100% failure on a *single* bad call. Real implementations agree on this: resilience4j's `CircuitBreaker` computes a failure rate over a sliding window and will not evaluate it below a configured minimum number of calls; Hystrix's equivalent is `circuitBreaker.requestVolumeThreshold`. Consecutive-failure counting is not wrong because the number is arbitrary — it's wrong because "three in a row" and "three out of a thousand" are different facts about the world, and a counter cannot tell them apart while a rate can.
- **windowMs: a timestamped array here, a bucketed ring in a system that cares about allocation.** `pruneWindow` (`src/circuitBreaker/breaker.js:50-52`) filters an array on every call — O(window size) per call, and it allocates a new array every time. That is the honest, readable version of the idea. A production breaker under real load typically uses a ring of fixed-size time buckets (resilience4j's sliding window is exactly this) so a call is O(1) and nothing is reallocated; the tradeoff is precision — a bucketed window rounds every outcome to its bucket's edge, where a timestamped array is exact to the millisecond. For a teaching example, and for the volumes this app will ever see, the array's simplicity is worth more than the ring's constant factor.
- **Why timeouts are mandatory, and why "slow" must be treated as "failed."** A call with no timeout cannot be broken by any breaker: the request just hangs, holding a connection, and `call()` never gets an outcome to record — not a failure, not a success, nothing. `AbortSignal.timeout(timeoutMs)` (`src/notifier/webhook.js:31`) is what turns "hung" into "failed" at all. And a dependency that takes 30 seconds to answer is worse than one that refuses in 1ms: the fast failure frees the connection and the caller's attention immediately, while the slow one occupies both for 30 seconds while looking, to a naive caller, like it might still succeed. This is the whole thesis of the AWS Builders' Library piece on timeouts in the further reading below.
- **What to count as a failure, and why counting 4xx is the classic misconfiguration.** This is the mistake that makes a circuit breaker actively harmful instead of merely useless: if a breaker counts every non-2xx response as a failure, then a client bug that sends one malformed field will get a 400 back, the breaker will count it, and if that bug fires on every request (which a client bug usually does, since it's deterministic), the breaker will trip on 100% "failures" that have nothing to do with the upstream's health — and then it starts rejecting the *correctly-formed* requests too, which is the breaker doing real damage to a healthy path because of a bug in the caller. `isWebhookFailure` (`src/notifier/webhook.js:12-17`) draws the line where it actually belongs: a 4xx (other than 408/429) is the caller's fault, a 5xx or a timeout is the upstream's. Never let "any non-2xx" be the failure predicate.
- **Relationship to neighbouring patterns — say which layer owns what.** *Timeout* is a precondition for a breaker to work at all (above). *Retry with exponential backoff and jitter* sits on the *other* side of the breaker call and has to be configured with it in mind, not against it: a retry that fires on every failure inflates the failure count the breaker sees, which trips it faster — sometimes that's exactly right (a truly down dependency should trip fast), and sometimes it's wrong (three retries per logical call turn a 20%-error dependency into something that looks like 50%+ to the breaker). The safe rule: retries belong *inside* a single `call()` to the breaker, never wrapping the breaker in a loop that calls it repeatedly — the breaker should see one outcome per logical request. *Bulkhead* limits how much of a shared resource (usually a connection pool or thread pool) one dependency can consume, so a failing dependency can't starve unrelated calls of capacity — a breaker stops you calling a dependency, a bulkhead stops one dependency's calls from starving everything else regardless of whether it's failing. *Load shedding* rejects work at the front door based on the caller's own capacity (queue depth, CPU), not on any single dependency's health — a breaker is dependency-specific, load shedding is about you. *Hedged requests* fire a second, redundant request after a delay to cut tail latency, trading extra load for speed — nearly the opposite instinct to a breaker, which exists to send *less* traffic to something struggling. *Graceful degradation / fallback* is what a breaker's caller does once it decides not to call the dependency at all — the breaker only decides "don't call"; what happens instead is a separate decision (next bullet).
- **Per-process state is usually correct, not a limitation to apologize for.** This app runs one instance, so `defaultNotifier`'s breaker (`src/notifier/webhook.js:54`) sees every call and there is exactly one view of "is the webhook healthy." With N instances, each process gets its own breaker, learns independently from its own traffic, and can trip at a different moment than its siblings — and that is usually what you want: sharing breaker state across instances means introducing a network call (to Redis, to a coordination service) *inside the component whose entire job is surviving network failures*, which is a strange thing to make depend on the network. It also means one instance with a locally bad path to the dependency (a bad connection, a partial network partition) can open the circuit for every other instance, even the ones that could still reach it fine. A shared/coordinated view earns its cost only when the fleet genuinely needs synchronized behavior faster than "each instance notices on its own traffic within one window" — e.g., a very large fleet where you want to stop a stampede on recovery in a single half-open trial fleet-wide, rather than N independent trials. That is a deliberate, expensive choice (a shared store, its own availability and latency budget, and a new way for the whole fleet to fail together), not a default.
- **Observability.** State transitions are the events an operator acts on, not the individual failures — `onStateChange` (`src/circuitBreaker/breaker.js:24,45`) fires exactly on `closed→open`, `open→half-open`, `half-open→closed`, and `half-open→open`, and `src/notifier/webhook.js:19-21` logs every one of them with the `stats()` that caused it (state, total, failures, successes). An alert on "the webhook breaker opened" that doesn't also carry those numbers is not actionable — an operator needs to know it was 5 failures out of 5 calls, not 5 failures out of 4,000, before deciding whether to page anyone.
- **Fallbacks, once the breaker says no.** Fail fast with a clear error (what this notifier does — and a legitimate choice, not a cop-out: the alternative to "tell the caller now" is usually "let them find out from a 30-second hang" or "silently drop it," both worse); serve stale data if you have a cache; degrade to a reduced feature (skip the notification, keep the ticket); queue the work for later delivery once the dependency recovers. Which one is right is a product decision the breaker has no opinion on — it only decides when to stop trying.
- **Where this belongs in a real system.** Most production HTTP clients (`resilience4j`, Polly, and the Hystrix generation before them) put the breaker in a client library, wrapping the specific outbound call — exactly where this app puts it. A service mesh (Envoy and friends) can give you the closely-related idea of outlier detection at the infrastructure layer, ejecting a misbehaving upstream host from the load-balancing pool with zero application code — but that operates on hosts behind a single logical upstream, not on "this dependency is unhealthy" in the way an application-level breaker does, and it is invisible to the application: your code has no `state` to log, no `stats()` to alert on, and no way to choose a fallback, because the mesh made the call before your code ran.

## Standard practice

- Always pair a breaker with a timeout on the call it wraps — a breaker around a call with no timeout can starve waiting for an outcome it will never get to record.
- Trip on rate over a window with a minimum throughput, never on a bare consecutive-failure count — see the core concepts above for exactly what goes wrong otherwise.
- Make `isFailure` explicit and specific to the protocol being called — "any thrown error" is a reasonable default, "any non-2xx response" is the bug waiting to happen.
- Keep half-open to a small, fixed number of trial calls — it exists to answer "has this recovered?" cheaply, not to ramp traffic back up.
- Clear the window on a successful close — a dependency that recovers should get judged on what it does next, not on the outage that just ended.
- Log every state transition with the stats behind it, not just "breaker tripped" — the numbers are what let a human decide whether to act.
- Keep breaker state per-instance unless the fleet has a specific, justified reason to share it — see "Per-process state" above.
- Never let a breaker sit between a caller and a call the caller cannot afford to fail — make dependent calls fire-and-forget (like this notifier) or give them an explicit fallback, so "the breaker is open" is never the reason a user-facing write fails.

## What this toy skips

- Bucketed/ring windows — `pruneWindow` (`src/circuitBreaker/breaker.js:50-52`) is a linear filter over a plain array, fine at this app's volume, not fine at real production request rates.
- Slow-call detection as its own failure category — resilience4j lets you mark a call that *succeeded* but took too long as a failure for breaker purposes, independent of the timeout that would eventually abort it. This breaker only knows "threw" or "didn't."
- Any of the extra resilience4j states (`FORCED_OPEN`, `DISABLED`, `METRICS_ONLY`) for manually overriding the breaker during an incident or a deploy.
- Per-call configuration or multiple breaker instances sharing a policy registry — this app builds exactly one breaker for exactly one dependency; a real client library manages many.
- Coordinated/shared breaker state across instances — deliberately out of scope; see "Per-process state" above for why that is usually the right call anyway, and what it costs when it isn't.
- Structured, per-transition metrics export (a counter or histogram a monitoring system can alert on) — transitions go to `console.log`/`console.error`, not a metrics pipeline.
- Retry, bulkhead, load shedding, and hedged requests themselves — this module only implements the breaker; the neighbouring patterns are named and scoped in the core concepts above but none of them exist in this codebase.
- A `FORCED_OPEN`-style manual override for an operator to trip the breaker ahead of a known-bad deploy, before any real failure has been observed.

## Try it

Point the webhook at an upstream you control so you can flip it between healthy and failing. The snippet below is a two-route `node:http` server: `/` is the webhook target and returns 500 until you hit `/heal`, then 200.

```js
import http from 'node:http'
let fail = true
http.createServer((req, res) => {
  if (req.url === '/heal') { fail = false; res.writeHead(200); res.end('ok'); return }
  res.writeHead(fail ? 500 : 200)
  res.end()
}).listen(4600, '127.0.0.1', () => console.log('fake upstream on 4600'))
```

Run it, then point the app at it and start it:

```bash
node fake-upstream.js &
echo "TICKET_WEBHOOK_URL=http://127.0.0.1:4600" >> .env
npm run seed
npm run dev
```

Log in as a seeded reporter to get an id, then create five tickets *in quick succession* — the default window is 10 seconds, so five slow, hand-typed curls spaced further apart than that will never accumulate enough failures to trip (that is the rolling window working correctly, not a bug):

```bash
curl -s -X POST http://localhost:5001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"lee@tickets.test","password":"demo1234"}'

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:5001/api/tickets \
  -H 'Content-Type: application/json' -H 'x-user-id: <lee id>' \
  -d '{"title":"t1","body":"trip body","priority":"normal"}'
```

Repeat that last call five times back to back. Every one still returns `201` — ticket creation never sees the webhook at all — but the server log shows the breaker deciding underneath it:

```
webhook notify failed: webhook responded 500
webhook notify failed: webhook responded 500
webhook notify failed: webhook responded 500
webhook notify failed: webhook responded 500
webhook breaker closed -> open stats={"state":"open","total":5,"failures":5,"successes":0}
```

A sixth create (from a user with throttle budget left) still returns `201` while the breaker is `open`; once `openMs` (5s) has passed, the *next* call is the half-open trial — against the still-failing upstream it reopens and restarts the clock:

```
webhook breaker open -> half-open stats={"state":"half-open","total":5,"failures":5,"successes":0}
webhook breaker half-open -> open stats={"state":"open","total":1,"failures":1,"successes":0}
```

Now heal it (`curl http://127.0.0.1:4600/heal`) and create one more ticket after `openMs` has passed again:

```
webhook breaker open -> half-open stats={"state":"half-open","total":1,"failures":1,"successes":0}
webhook breaker half-open -> closed stats={"state":"closed","total":0,"failures":0,"successes":0}
```

Closed, window cleared, back to normal — and at no point did any of the `POST /api/tickets` calls return anything but `201`.

## Further reading

- [Michael Nygard, *Release It!*, 2nd edition](https://pragprog.com/titles/mnee2/release-it-second-edition/) — the book that introduced the circuit breaker as a stability pattern, alongside timeouts and bulkheads; the pattern's actual origin, not a summary of it.
- [Martin Fowler, CircuitBreaker](https://martinfowler.com/bliki/CircuitBreaker.html) — closed/open/half-open in about a page, with the attribution to Nygard and worked code.
- [Netflix Hystrix](https://github.com/Netflix/Hystrix) — the implementation that popularized the pattern in distributed systems generally, including `requestVolumeThreshold` (this app's `minimumThroughput`); the repo's own "Hystrix Status" section states it is in maintenance mode and no longer actively developed, worth reading precisely because a widely-copied pattern can outlive the project that popularized it.
- [resilience4j, CircuitBreaker](https://resilience4j.readme.io/docs/circuitbreaker) — the modern JVM equivalent: sliding-window failure rate, a configurable minimum number of calls, slow-call detection as a distinct signal, and manual override states this toy skips.
- [Polly, Circuit breaker resilience strategy](https://www.pollydocs.org/strategies/circuit-breaker.html) — the .NET equivalent, with the same shape and its own terms for half-open and manual isolation.
- [AWS Builders' Library, Timeouts, retries, and backoff with jitter (Marc Brooker)](https://d1.awsstatic.com/builderslibrary/pdfs/timeouts-retries-and-backoff-with-jitter.pdf) — why a call with no timeout is unbreakable by any breaker, and how retries interact with (and can defeat) one.
- [AWS Builders' Library, Using load shedding to avoid overload (David Yanacek)](https://d1.awsstatic.com/builderslibrary/pdfs/using-load-shedding-to-avoid-overload.pdf) — load shedding as the neighbouring pattern that protects your own capacity rather than a dependency's.
- [Google, *Site Reliability Engineering*: Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/) — how retries, slow dependencies, and no circuit breaking combine to turn a small failure into a full outage; the systemic case for this whole pattern.
- [Google, *Site Reliability Engineering*: Handling Overload](https://sre.google/sre-book/handling-overload/) — client-side throttling and criticality, the chapter load shedding and bulkheads both draw from.
- [Envoy, Outlier detection](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier) — the infrastructure-layer, host-level cousin of an application circuit breaker, and why it is invisible to application code in a way this module deliberately is not.

Elsewhere in this repo: [`../hooks/README.md`](../hooks/README.md) for the fail-open call this notifier's fire-and-forget contract is modeled on, and for the paragraph that names a circuit breaker as the fix for a handler that times out on every request; [`../throttle/README.md`](../throttle/README.md) for the lazy, no-timer evaluation trick this breaker reuses for its own state transitions.
