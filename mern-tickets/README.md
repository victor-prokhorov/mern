# mern-tickets

A support-ticket API, built to teach eight things: the ticketing domain itself, an authorization policy engine, keyword blocking, per-user throttling, a pluggable moderation hook pipeline, a circuit breaker protecting an outbound webhook, optimistic concurrency on ticket writes, and a request-scoped observability layer. API only, no client — every concept here is server-side. Layering matches `mern-shop/server`: `routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own every Mongoose call, `middleware/` holds cross-cutting concerns.

## Requirements

- Node 20+
- A local MongoDB on `mongodb://127.0.0.1:27017`

## Run it

```bash
cd server
npm install
cp .env.example .env
npm run seed
npm run dev
```

API on `http://localhost:5001`. Note `mern-movies` defaults to the same
port, so the two cannot both run on a default `.env` — whichever starts
second dies with `EADDRINUSE`. Start one of them with `PORT=5002` if you
want both. `npm run seed` creates one admin, two agents, three reporters (`ada@tickets.test` / `gale@tickets.test` / `remy@tickets.test` / `rae@tickets.test` / `sam@tickets.test` / `lee@tickets.test`, password `demo1234` for all) and five tickets spread across statuses.

## Tests

```bash
cd server
npm test
npm run test:ci
```

`npm test` drops and rebuilds the `mern-tickets-test` database on every run, so a local `mongod` must be running. `test:ci` additionally writes JUnit XML to `server/test-results/results.xml`.

## Feature READMEs

Each feature has its own README, written to be read in five minutes and to leave you able to argue about the topic correctly:

- [`server/src/tickets/README.md`](server/src/tickets/README.md) — the ticketing domain: the status state machine, the append-only `TicketEvent` audit trail, and SLA-derived due dates.
- [`server/src/policy/README.md`](server/src/policy/README.md) — the authorization policy engine: default deny, deny-overrides, RBAC plus ABAC conditions, and the PDP/PEP split.
- [`server/src/moderation/README.md`](server/src/moderation/README.md) — keyword blocking: the normalization pipeline, word-boundary matching and the Scunthorpe problem, allowlists, and severity tiers.
- [`server/src/throttle/README.md`](server/src/throttle/README.md) — per-user token bucket throttling: lazy refill, atomic consume, and how throttling differs from rate limiting, quotas, and backpressure.
- [`server/src/hooks/README.md`](server/src/hooks/README.md) — the moderation hook registry: the continue/reject/transform contract, fail-open handlers, and where the keyword blocker, link-limit check, and duplicate-content check plug in.
- [`server/src/circuitBreaker/README.md`](server/src/circuitBreaker/README.md) — the circuit breaker protecting the outbound ticket webhook: closed/open/half-open, error rate over a window with a minimum throughput, and why counting 4xx as a failure is the classic misconfiguration.
- [`server/src/concurrency/README.md`](server/src/concurrency/README.md) — optimistic concurrency on ticket writes: the lost update problem, a `version` counter as a compare-and-swap in one database operation, and why `If-Match` earns a 412 and a missing header earns a 428.
- [`server/src/observability/README.md`](server/src/observability/README.md) — request ids and `AsyncLocalStorage` correlation, structured JSON logging, RED metrics with bounded label cardinality, liveness versus readiness, and graceful shutdown.

Read them in that order — each feature after the first wires into the one before it.

## Optional environment

`.env.example` covers `PORT` and `MONGO_URI`. `TICKET_WEBHOOK_URL` is commented
out there: leave it unset and `notify()` is a no-op, which is why the app runs
fine without a webhook anywhere. Set it to exercise the circuit breaker — the
guide above ships a two-route fake upstream you can point it at.

## Auth, honestly

Every route identifies its caller with an `x-user-id` header. That is not authentication — there is no password check on these routes, no session, no token. It exists only so the rest of the request has a caller to reason about; the [policy engine](server/src/policy/README.md) then decides what that caller may do. See [`server/src/tickets/README.md`](server/src/tickets/README.md) for the full explanation, and [`mern-shop/server/src/session/README.md`](../mern-shop/server/src/session/README.md) for what real token-based authentication looks like in this repo — that is the piece this app deliberately does not have.
