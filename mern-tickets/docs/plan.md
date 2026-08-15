# mern-tickets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A support-ticket API that carries four teaching features: the ticketing domain itself, an authorization policy engine, keyword blocking, and per-user throttling with a pluggable moderation hook.

**Architecture:** Same layering as mern-shop — `routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own every Mongoose call, `middleware/` holds cross-cutting concerns. API only, no client: every concept here is server-side.

**Tech Stack:** Node (ESM), Express, Mongoose, bcrypt, mocha, chai, chai-http.

## Global Constraints

- Dependencies exactly as mern-shop: bcrypt, cors, dotenv, express, express-async-errors, mongodb, mongoose, chai, chai-http, mocha, mocha-junit-reporter, mocha-multi-reporters, cross-env. `node:crypto` is built in and allowed. No Redis, no policy library, no profanity package — building them is the point.
- No comments in source or tests. Explanation lives in the READMEs.
- No blank lines inside function bodies, except test bodies (setup / blank / run / blank / assert).
- ESM, `.js` extensions on relative imports.
- Test database `mern-tickets-test`, dropped before each test, indexes rebuilt after each drop (copy the `syncIndexes` helper from `mern-shop/server/test/helpers.js`).
- TDD: failing test first with real red output in the commit body, then the fix.
- One branch and PR per task: `feat/tickets-core`, `feat/tickets-authz`, `feat/tickets-keyword-blocking`, `feat/tickets-throttling`.

## README requirements (every feature)

One page, finished in five minutes, in this order: **What this is** (two sentences) / **How it works here** (flow with real file:line references) / **The core concepts** (vocabulary, tersely defined) / **Standard practice** (checklist of rules, one-line why each) / **What this toy skips** / **Try it** (copy-pasteable curl). Plain prose, no emoji, no marketing.

---

### Task 1: Ticketing core (`feat/tickets-core`)

Scaffold `mern-tickets/server` exactly like `mern-shop/server` (package.json scripts, `.mocharc.json`, `.env.example`, `app.js` split from `index.js`, error middleware with the same typed classes plus `ForbiddenError` 403 and `TooManyRequestsError` 429), then the domain.

**Models**
- `User { name, email unique, passwordHash, role: 'reporter' | 'agent' | 'admin', teamId }`
- `Ticket { title, body, status, priority, reporter, assignee, teamId, dueAt, createdAt, updatedAt }`
- `Comment { ticket, author, body, createdAt }`
- `TicketEvent { ticket, actor, type, from, to, at }` — an append-only audit trail

**Rules**
- Status lifecycle is a state machine: `open → triaged → in_progress → resolved → closed`, plus `resolved → open` (reopen). Any other transition is 400 `invalid status transition`. The allowed transitions live in one exported map, not in `if` statements.
- Priority is `low | normal | high | urgent`. `dueAt` is derived from priority on creation (urgent 4h, high 1 day, normal 3 days, low 7 days) — an SLA target.
- Every mutation appends a `TicketEvent`. The audit trail is the feature, not a nicety.

**Endpoints:** login (bcrypt, same shape as mern-shop); `POST /api/tickets`; `GET /api/tickets` with `status`, `assignee`, `priority` filters; `GET /api/tickets/:id` (ticket + comments + events); `PATCH /api/tickets/:id/status`; `PATCH /api/tickets/:id/assignee`; `POST /api/tickets/:id/comments`.

**Auth for now:** the caller identifies with `x-user-id`. That is not authentication and the README must say so, pointing at Task 2 for authorization and at mern-shop for password handling.

**Seed:** one admin, two agents, three reporters, a handful of tickets across statuses.

**Tests:** each legal transition passes; a few illegal ones 400; `dueAt` matches priority; every mutation writes an event; filters work; comments attach.

**README** — `server/src/tickets/README.md`. Concepts: modelling a workflow as an explicit state machine instead of a status string anyone can set; audit trails and append-only event logs; SLA clocks and business hours; assignment and queues; soft transitions vs hard deletes; why the lifecycle belongs in the service layer.

---

### Task 2: Authorization policy engine (`feat/tickets-authz`)

**Files:** `server/src/policy/engine.js`, `server/src/policy/policies.js`, `server/src/policy/README.md`, plus wiring into every ticket service function. Test: `server/test/policy.test.js`.

**Requirements**
- The engine evaluates a **request** `{ subject, action, resource, context }` and returns a **decision** `{ effect: 'permit' | 'deny', reason, ruleId }`. Never a bare boolean — the reason is what makes an authz system debuggable.
- **Default deny.** An empty policy set denies everything; a test asserts it.
- **Deny overrides permit.** If any rule denies, the decision is deny regardless of matching permits; a test asserts it with a deliberately conflicting pair.
- Rules are data, not code: `{ id, effect, actions, roles, condition }` where `condition(request)` is a small pure predicate. Policies live in `policies.js` as an array, so the whole policy set is readable in one screen.
- Policy set to implement (RBAC roles plus ABAC conditions):
  - reporters may `ticket:create`; may `ticket:read` and `ticket:comment` **only on their own tickets**;
  - agents may read, comment, transition and assign tickets **in their own team**;
  - admins may do anything except `ticket:delete` — an explicit deny rule that beats their wildcard permit, which is what demonstrates deny-overrides;
  - nobody may transition a `closed` ticket except an admin (condition on resource state, not role alone).
- **One enforcement point per action.** Services call `authorize(request)` and let it throw `ForbiddenError`; controllers never check roles. The README names this the PEP/PDP split.
- The 403 body carries a generic message; the reason and ruleId go to the server log only.

**Tests:** default deny with an empty policy set; deny-overrides with a conflicting pair; reporter can read own ticket, 403 on another's; agent bounded by team; admin denied delete; closed-ticket transition allowed only for admin; the decision object always carries a reason.

**README** — `server/src/policy/README.md`. Concepts: authentication vs authorization; RBAC vs ABAC vs ReBAC, with when each stops scaling; PDP / PEP / PIP / PAP; default deny and deny-overrides; policies as data and why that enables testing and audit; centralizing decisions so there is one place to change; row-level vs endpoint-level authorization and why endpoint-only checks leak data; testing a policy set like a truth table; the confused-deputy problem; what OPA/Cedar/Casbin give you over this.

---

### Task 3: Keyword blocking (`feat/tickets-keyword-blocking`)

**Files:** `server/src/moderation/normalize.js`, `server/src/moderation/keywords.js`, `server/src/moderation/README.md`, `server/src/models/blockedTerm.js`, repository, wiring into ticket and comment creation. Test: `server/test/keywords.test.js`.

**Requirements**
- Terms live in the database: `BlockedTerm { term, severity: 'block' | 'flag', matchType: 'word' | 'substring', createdBy }`.
- **Normalization pipeline before matching**, each step its own exported function so each is testable: Unicode NFKC; lowercase; strip zero-width characters; collapse repeated letters (`heeeello` → `hello`); map common homoglyphs and leetspeak (`0→o`, `1→i`, `@→a`, `$→s`, Cyrillic `а→a`).
- **Word-boundary matching by default.** The README must name the Scunthorpe problem and the test suite must include a case proving an innocent word containing a blocked substring passes when `matchType: 'word'`.
- An **allowlist** of exempt phrases that suppresses a match (`assassin` when `ass` is blocked) — precedence rules stated in the README.
- Outcome is not binary: `block` → 400 `content rejected`, nothing persisted; `flag` → persisted with `moderation: { flagged: true, terms: [...] }` and left for a human. Reporters are not told which term matched — evasion feedback loop.
- Matching must be **linear in the text length** with respect to the term set (build a Set or a trie, do not loop every term over every message) and the README explains why naive matching is a denial-of-service surface.

**Tests:** each normalization step in isolation; leetspeak and homoglyph evasion caught; Scunthorpe case passes; allowlist suppresses; `block` rejects and persists nothing; `flag` persists with metadata; the rejection message names no term.

**README** — `server/src/moderation/README.md`. Concepts: why `text.includes(word)` is the wrong primitive; normalization and the evasion arms race; word boundaries and the Scunthorpe problem; false positives as a product cost; severity tiers instead of block/allow; keyword lists as a layer, not a moderation strategy (classifiers, reputation, rate limits, human review); allowlists; localization; auditability and appeal; performance and DoS.

---

### Task 4: Throttling and the moderation hook (`feat/tickets-throttling`)

**Files:** `server/src/throttle/tokenBucket.js`, `server/src/throttle/README.md`, `server/src/hooks/registry.js`, `server/src/hooks/README.md`, model + repository for bucket state, wiring into ticket and comment creation. Tests: `server/test/throttle.test.js`, `server/test/hooks.test.js`.

**Throttling requirements**
- A **token bucket per user per action**, persisted in Mongo: `{ key, tokens, updatedAt }`, refilled lazily from elapsed time at a configured rate, consumed atomically. Ticket creation: burst 5, refill 1 per minute. Comments: burst 20, refill 5 per minute.
- Refill must be computed from elapsed time, not a cron. A test manipulates `updatedAt` into the past and asserts tokens came back proportionally.
- Rejection is 429 with `Retry-After` set to the time until the next whole token.
- The README must draw the distinction sharply: **rate limiting** protects the service from aggregate load and is usually per-IP at the edge; **throttling** shapes a single actor's sustained rate and allows bursts; **quotas** are billing periods; **backpressure** is what a queue does when it cannot keep up. Cross-reference `mern-shop/server/src/rateLimit/README.md`.

**Moderation hook requirements**
- A **hook registry**: `register(event, handler)` and `run(event, payload)` where handlers execute in registration order and each returns `{ action: 'continue' | 'reject' | 'transform', ... }`.
- Events: `ticket:before-create`, `comment:before-create`.
- Handlers registered at startup: the keyword blocker from Task 3, a link-limit handler (more than 3 URLs → flag), and a duplicate-content handler (identical body from the same user within 60 seconds → reject).
- Contract rules the README must state and the code must obey: a `reject` short-circuits the chain; `transform` passes its modified payload to the next handler; a handler that **throws** is logged and skipped (fail-open for moderation, which is the opposite choice from a payments hook, and the README must explain why the choice differs); handlers get a timeout budget and the pipeline is synchronous by design here, with the async/queue alternative described.

**Tests:** bucket allows the burst then blocks; lazy refill restores tokens; `Retry-After` is correct; buckets are per-user and per-action; hooks run in order; reject short-circuits; transform reaches the next handler; a throwing handler is skipped without failing the request; duplicate detection works inside the window and not outside it.

**READMEs** — two, as listed. The hooks one covers: hooks vs middleware vs events vs webhooks; sync vs async moderation and the latency/consistency tradeoff; idempotency; ordering and priority; failure modes and fail-open vs fail-closed by domain; timeouts and circuit breakers; observability of a pipeline that silently mutates content.

---

## Notes for the executor

- Build Task 1 first; the other three wire into it.
- Copy conventions from `mern-shop/server`, do not import across apps — each app is standalone.
- `mern-tickets/README.md` gets a short index linking every feature README.
