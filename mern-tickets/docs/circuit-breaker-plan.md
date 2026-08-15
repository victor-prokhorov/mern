# Circuit Breaker Implementation Plan (mern-tickets)

**Goal:** A circuit breaker protecting a real outbound dependency, with the same shape as every other topic in this repo: tests that fail when the behaviour breaks, and a README beside the code.

**Where it lands:** `mern-tickets/server/src/circuitBreaker/` (the breaker itself) and `mern-tickets/server/src/notifier/` (the outbound dependency it protects). Copy this plan to `mern-tickets/docs/circuit-breaker-plan.md` in your first commit.

**Branch:** `feat/tickets-circuit-breaker`. One branch, commit per task, TDD red then green with the real failing output in each red commit body. Do not open a PR.

## Global constraints

- Dependency list is closed: bcrypt, cors, dotenv, express, express-async-errors, mongodb, mongoose, chai, chai-http, mocha, mocha-junit-reporter, mocha-multi-reporters, cross-env. Node built-ins are allowed and are what you should use here — `node:http` for the fake upstream in tests, global `fetch` and `AbortSignal.timeout` for the outbound call. No axios, no opossum, no nock, no sinon.
- No comments in source or tests. Explanation goes in the README.
- No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert.
- ESM, `.js` extensions on relative imports.
- The existing 84 tests must keep passing, unedited.
- Layering holds: only `repositories/` import models; no `req`/`res` in services or repositories. The breaker is infrastructure, not a service — it does not touch the database at all.

---

## Task 1: The breaker state machine

`src/circuitBreaker/breaker.js`. A pure, in-memory, per-process state machine. No timers, no database, no Express.

**States:** `closed` (calls pass through), `open` (calls rejected immediately), `half-open` (a limited number of trial calls allowed).

**Configuration**, all injectable with sensible defaults:
- `failureRateThreshold` (default 0.5) and `minimumThroughput` (default 5) — the breaker trips on error *rate* over a rolling window, but only once it has seen enough calls to have an opinion. A naive consecutive-failure counter is the common wrong answer; the README must explain why (one slow morning of 50% errors matters more than three unlucky calls in a row, and a low-traffic endpoint should not trip on two).
- `windowMs` (default 10000) — the rolling window over which outcomes are counted. Implement as a simple bucketed ring or a timestamped array; explain the tradeoff in the README.
- `openMs` (default 5000) — how long the circuit stays open before allowing a trial.
- `halfOpenMaxCalls` (default 1) and `successesToClose` (default 1).
- `now` injected as a function, defaulting to `Date.now`. Same discipline as the fraud signals: **time is an input**, so every state transition is testable without sleeping.

**Behaviour:**
- Transitions are evaluated lazily on each call, not by a background timer. Same trick as the token bucket refill: no scheduler, nothing to leak.
- `open → half-open` happens when `openMs` has elapsed, checked at call time.
- In `half-open`, at most `halfOpenMaxCalls` are in flight; further calls are rejected as if open. A success closes the breaker and resets the window; a failure re-opens it and restarts the clock.
- Rejection while open must be **immediate** — the entire point is to stop paying the latency of a call you expect to fail. A test must assert no call to the wrapped function was made.
- Expose `state`, and `stats()` returning the counts the decision was based on. An operator with no visibility into why a breaker tripped cannot act on it.
- Emit a transition callback (`onStateChange`) so transitions can be logged. Log every transition in the wiring: state changes are the events an on-call engineer needs.

**Errors:** a rejection while open throws a typed error carrying the state and the time until the next trial. Map it to HTTP 503 with `Retry-After` where it reaches a response, and say in the README why 503 rather than 500 or 502.

**What counts as a failure** is the caller's decision, via an `isFailure(error)` predicate defaulting to "any throw". This matters: a 400 from an upstream is *your* bug, not the upstream being unhealthy, and counting it trips the breaker for no reason. Timeouts always count. The README must make this point — it is the single most common misconfiguration.

**Tests** (`test/circuitBreaker.test.js`), all against injected time, none sleeping:
- stays closed while under the failure-rate threshold;
- does not trip below `minimumThroughput` even at a 100% failure rate;
- trips once both threshold and throughput are met;
- rejects immediately while open, with the wrapped function never invoked;
- moves to half-open after `openMs` on the next call, not before;
- a successful trial closes it and clears the window;
- a failed trial re-opens it and restarts the clock;
- only `halfOpenMaxCalls` trials are admitted concurrently;
- a timeout counts as a failure;
- an error rejected by `isFailure` does not count;
- `stats()` reports the numbers behind the decision.

---

## Task 2: The dependency it protects

`src/notifier/webhook.js`. Ticket events are POSTed to a webhook URL from `process.env.TICKET_WEBHOOK_URL`.

- Uses global `fetch` with `AbortSignal.timeout(timeoutMs)` (default 1000). **A call with no timeout cannot be broken by any breaker** — the request just hangs, holding a socket, and the breaker never sees an outcome. Make that explicit in the README.
- Wrapped in a breaker instance created at module scope: one breaker per dependency, per process.
- Non-2xx responses and timeouts are failures; a 4xx that is not 408 or 429 is *not* counted (upstream saying "your request is malformed" is not an outage), demonstrating `isFailure`.
- Fire-and-forget from the ticket service after create and after a status change: a webhook must never fail the ticket write. This is the same fail-open call as the moderation hooks, and the README should cross-reference `../hooks/README.md`.
- If no `TICKET_WEBHOOK_URL` is configured, the notifier is a no-op — the app must run without one.
- Every state transition is logged with the stats that caused it.

**Tests** (`test/notifier.test.js`), using a real `node:http` server on an ephemeral port as the fake upstream, so the whole path including `fetch` is exercised:
- a 200 upstream records success and the ticket is created normally;
- a 500 upstream repeated past the threshold trips the breaker, and subsequent calls do not reach the upstream (assert on a request counter in the fake server);
- an upstream that never responds is cut off by the timeout and counted as a failure;
- a 400 upstream does not trip the breaker;
- the breaker recovers: after `openMs` with the upstream healthy again, traffic resumes;
- ticket creation still returns 201 while the breaker is open.

---

## Task 3: The README

`src/circuitBreaker/README.md`, same seven sections as every other topic in this repo, in order: **What this is** / **How it works here** (with real file:line references) / **The core concepts** / **Standard practice** (checklist, one line of why each) / **What this toy skips** / **Try it** (runnable curl, including how to point the webhook at a URL you control and watch the breaker trip) / **Further reading**.

Concepts that must be covered, correctly and specifically:

- The three states and why half-open exists at all — without it, recovery is either a thundering herd or a manual intervention.
- **Error rate over a rolling window with a minimum throughput**, versus consecutive failures. Name what real implementations do.
- Why **timeouts are mandatory** and why "slow" must be treated as "failed": a dependency that responds in 30 seconds is worse than one that refuses in 1ms, because it consumes your connections while it does it.
- **What to count as a failure**, and why counting 4xx is the classic misconfiguration.
- The relationship to its neighbours: **timeout**, **retry with exponential backoff and jitter**, **bulkhead**, **load shedding**, **hedged requests**, **graceful degradation / fallback**. Retry and breaker interact badly if you are careless — retries inflate the failure count and trip the breaker faster, which is sometimes what you want and sometimes not. Say which layer owns what.
- **Per-process state.** This repo runs one instance, so the breaker sees every call. With N instances each has its own view, learns independently, and trips at different times — which is usually correct: sharing breaker state across instances adds a network dependency to the component whose job is surviving network failures, and risks one instance's bad node opening the circuit for everyone. Cover when a shared/coordinated view is actually wanted, and what it costs.
- **Observability**: state transitions are the events that matter, and the stats behind them are what makes an alert actionable.
- **Fallbacks**: fail fast, serve stale, degrade, or queue — and that "fail fast with a clear error" is a legitimate fallback, not a cop-out.
- Where this belongs in a system: usually in the client library or the service mesh, and the README should note that a mesh (Envoy and friends) gives you outlier detection without application code, with the tradeoff of being invisible to the application.

**Further reading**: six to ten entries. Fetch every URL before including it; a 404 is a defect. Prefer primary and canonical sources — Nygard's *Release It!* for the pattern's origin, the Hystrix documentation for the design that popularised it and its own "Hystrix is in maintenance" note, resilience4j and Polly documentation for how it is done now, the AWS Builders' Library on timeouts/retries/backoff-with-jitter, the Google SRE book chapters on cascading failure and handling overload, Envoy's outlier detection documentation. One line each on what the reader gets.

Also add the topic to the `mern-tickets/README.md` index and to the root `README.md` topic table.

---

## Report

Write to `/private/tmp/claude-502/-Users-victor-p-mern/45166ac0-196d-4053-b8d5-e0370ad855fe/scratchpad/circuit-breaker-report.md`: what you built per task, TDD evidence (red command, real failing output, green command, passing output), the full suite result, every link with confirmation you fetched it, and any concern. Then reply with status, branch, commits, one-line test summary, concerns, report path — under 15 lines.
