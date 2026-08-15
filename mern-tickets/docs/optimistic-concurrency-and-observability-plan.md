# Plan B — mern-tickets: optimistic concurrency and observability

Two topics, same shape as every other in this repo. Copy this file to `mern-tickets/docs/optimistic-concurrency-and-observability-plan.md` in your first commit.

**Branch:** `feat/tickets-concurrency-observability`. Commit per task, TDD red then green with the real failing output in each red commit body. Do not open a PR.

## Global constraints

- Dependency list is closed and unchanged: bcrypt, cors, dotenv, express, express-async-errors, mongodb, mongoose, chai, chai-http, mocha, mocha-junit-reporter, mocha-multi-reporters, cross-env. Node built-ins are allowed and are what Task 2 needs — `node:async_hooks` for `AsyncLocalStorage`, `node:crypto` for ids. No pino, no winston, no prom-client, no opentelemetry.
- No comments in source or tests. No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert.
- ESM, `.js` extensions on relative imports.
- Layering holds: only `repositories/` import models; no `req`/`res` in services or repositories. The observability module is infrastructure — the middleware may touch `req`/`res`, the context and logger must not.
- The existing 112 tests must keep passing, unedited, except where Task 1 legitimately changes the update contract.
- A red run that aborts before the tests execute is a bad red.
- READMEs use the seven-section shape: What this is / How it works here (real file:line refs) / The core concepts / Standard practice (checklist, one line of why each) / What this toy skips / Try it (runnable curl) / Further reading (six to ten entries, every URL fetched before inclusion).

---

## Task 1 — Optimistic concurrency

**The problem:** two agents open the same ticket, both PATCH the status, and the second silently overwrites the first. Nobody gets an error; the first agent's change simply disappears. Silent data loss is the worst class of bug because nothing in the system reports it.

**Mechanics**

- Add a `version` integer to Ticket, incremented on every mutation. Mongoose has `__v` but does not enforce it on updates by default — use an explicit field so the behaviour is visible in the code rather than implied by the ODM, and say why in the README.
- Responses carry the version as a strong `ETag` header, and `GET /api/tickets/:id` includes it.
- `PATCH /api/tickets/:id/status` and `/assignee` accept `If-Match`. The update is a **compare-and-swap in one operation**: `findOneAndUpdate({ _id, version: expected }, { $set: …, $inc: { version: 1 } })`. A null result means someone else won.
- On conflict respond **412 Precondition Failed** with the current version and current state in the body, so a client can show the user what changed and retry deliberately. Explain 409 versus 412 in the README: 412 is the precondition-failed answer to a conditional request, 409 is the general conflict.
- A missing `If-Match` on a mutating endpoint: choose to **reject with 428 Precondition Required** and document the decision. Silently allowing last-write-wins when the header is absent defeats the whole mechanism, and 428 exists precisely for this.
- The audit event records the version transition, so the log shows exactly which write won.

**Tests**

- two concurrent PATCHes against the same version: exactly one succeeds, the other gets 412, and the ticket ends in the winner's state (construct both, then `Promise.all`);
- the 412 body carries the current version and state;
- a stale `If-Match` after a successful write is rejected;
- a missing `If-Match` is 428;
- the version increments exactly once per successful write, never on a rejected one;
- the ETag on `GET` round-trips into a successful `If-Match`;
- the audit event records the version.

**README** — `src/concurrency/README.md`. Concepts: the lost update problem, named and shown; optimistic versus pessimistic locking and when each is right (contention rate is the deciding factor); compare-and-swap as one atomic operation versus read-then-write; ETags, `If-Match`, 412 and 428; why version numbers beat timestamps (clock skew, same-millisecond writes); what this does *not* solve (two writes to different fields still conflict as a whole document — field-level merge and CRDTs are the next step); how it relates to the token bucket's CAS in `../throttle/README.md` and the atomic upsert in the shop's rate limiter.

---

## Task 2 — Observability

`src/observability/`.

**The problem:** when the hook pipeline rejects a ticket or the circuit breaker trips, nothing ties those log lines to the request that caused them.

**Mechanics**

- **Request id middleware**, mounted first: accept an inbound `X-Request-Id` if present and well-formed, otherwise mint one (`crypto.randomUUID`). Echo it on the response. Accepting inbound ids is what makes a trace span services; sanitise it (length cap, character allowlist) because it lands in logs.
- **`AsyncLocalStorage` context** carrying `{ requestId, userId, route }`, so any code anywhere in the call tree can log with correlation without threading an argument through every function. This is the piece that makes the hook pipeline and the breaker legible.
- **Structured logger**: one JSON object per line, with `level`, `msg`, `time`, plus the context fields. No string interpolation of variable data into the message — the message is a stable label and everything else is a field, because that is what makes logs queryable. Replace the existing `console.log` calls in the breaker and hooks with it.
- **RED metrics** at `GET /metrics` in Prometheus text format, hand-rolled: request **R**ate, **E**rror count, **D**uration histogram, labelled by route template and status class. Use the route *template* (`/api/tickets/:id`), never the concrete path — the README must explain cardinality, because unbounded label values are the classic way to take down a metrics backend and blow a budget.
- **Health endpoints**, and the distinction done properly: `/healthz` liveness answers "is this process wedged, should it be restarted" and must not depend on the database; `/readyz` readiness answers "should traffic be routed here" and must check Mongo. Conflating them means a database blip restarts every pod.
- **Graceful shutdown**: on SIGTERM, stop accepting new connections, let in-flight requests finish within a timeout, close the Mongo connection, exit. Flip readiness to failing *before* refusing connections so the load balancer drains first.

**Tests**

- an inbound `X-Request-Id` is echoed and appears in logs emitted deep in the call tree (assert by capturing the log writer, which should be injectable);
- a malformed inbound id is replaced rather than trusted;
- a minted id is stable across the whole request, including inside a hook handler and the breaker;
- `/metrics` counts requests, classifies statuses, and labels by route template not concrete path;
- `/readyz` fails when Mongo is disconnected while `/healthz` still passes;
- SIGTERM handling completes an in-flight request before exiting (drive it with a real server on an ephemeral port).

**README** — `src/observability/README.md`. Concepts: the three pillars and what each is actually for; RED versus USE; **cardinality** as the thing that kills metrics systems, with concrete examples of what not to label; structured logging and why message interpolation destroys queryability; log levels and sampling; correlation ids across async boundaries and why `AsyncLocalStorage` exists; liveness versus readiness versus startup probes, and the failure mode of conflating them; graceful shutdown and connection draining; what tracing adds over correlated logs and when it earns its cost; PII in logs.

---

## Report

Write to `/private/tmp/claude-502/-Users-victor-p-mern/45166ac0-196d-4053-b8d5-e0370ad855fe/scratchpad/tickets-concurrency-report.md`: per task, what you built, TDD evidence (red command and real failing output, green command and passing output), the full suite result, every link fetched, any concern. Reply with status, branch, commits, one-line test summary, concerns, report path — under 15 lines.
