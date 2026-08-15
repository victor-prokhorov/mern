# mern-tickets

A support-ticket API, built to teach five things: the ticketing domain itself, an authorization policy engine, keyword blocking, per-user throttling with a pluggable moderation hook, and a circuit breaker protecting an outbound webhook. API only, no client — every concept here is server-side. Layering matches `mern-shop/server`: `routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own every Mongoose call, `middleware/` holds cross-cutting concerns.

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

API on `http://localhost:5001`. `npm run seed` creates one admin, two agents, three reporters (`ada@tickets.test` / `gale@tickets.test` / `remy@tickets.test` / `rae@tickets.test` / `sam@tickets.test` / `lee@tickets.test`, password `demo1234` for all) and five tickets spread across statuses.

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

Read them in that order — each feature after the first wires into the one before it.

## Auth, honestly

Every route identifies its caller with an `x-user-id` header. That is not authentication — there is no password check on these routes, no session, no token. It exists only so the rest of the request has a caller to reason about; the policy engine (Task 2) then decides what that caller may do. See `server/src/tickets/README.md` for the full explanation, and `mern-shop/server/src/services/auth.js` for what real password-based login looks like in this pair of apps.
