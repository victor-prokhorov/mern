# Security Demos Implementation Plan (mern-shop)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four teaching features to mern-shop — password reset, rate limiting, user blocklist, fraud scoring — each with tests and a README beside the code explaining the standard practice.

**Architecture:** Everything follows the existing layering: `routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` hold every Mongoose call. New cross-cutting concerns live in `src/middleware/`. Each feature owns a directory with a `README.md` next to its implementation.

**Tech Stack:** Node (ESM), Express, Mongoose, bcrypt, node:crypto, mocha, chai, chai-http.

**Spec:** `docs/superpowers/specs/2026-08-14-mern-ecommerce-design.md` (the base app this extends)

## Global Constraints

- Dependencies stay exactly: bcrypt, cors, dotenv, express, express-async-errors, mongodb, mongoose, chai, chai-http, mocha, mocha-junit-reporter, mocha-multi-reporters, cross-env. `node:crypto` is built in and allowed. **No Redis, no email library, no rate-limit package** — the point is building them.
- No comments in any source or test file. Explanation goes in the READMEs.
- No blank lines inside function bodies, except test bodies (setup / blank / run / blank / assert).
- ESM, `.js` extensions on relative imports.
- The existing 32 tests must keep passing, unedited.
- Each task is its own branch and PR against `main`: `feat/password-reset`, `feat/rate-limiting`, `feat/user-blocklist`, `feat/fraud-scoring`.
- TDD: failing test first with the real red output in the commit body, then the fix.

## README requirements (every feature)

Each README is a single page a reader finishes in five minutes. Required sections, in this order:

1. **What this is** — two sentences.
2. **How it works here** — the flow through this codebase, with real file:line references.
3. **The core concepts** — the vocabulary a reader must own, defined tersely.
4. **Standard practice** — what production systems do, as a checklist of rules with a one-line *why* each.
5. **What this toy skips** — honest list of what a real system needs that this omits.
6. **Try it** — copy-pasteable curl commands against the running dev server.

Write plainly. No emoji. No marketing. A reader who knows nothing about the topic should be able to argue about it correctly afterwards.

---

### Task 1: Password reset flow

**Branch:** `feat/password-reset`

**Files:**
- Create: `server/src/models/passwordReset.js`
- Create: `server/src/repositories/passwordResets.js`
- Create: `server/src/services/passwordReset.js`
- Create: `server/src/controllers/passwordReset.js`
- Create: `server/src/passwordReset/README.md`
- Modify: `server/src/routes/auth.js`, `server/src/repositories/users.js`
- Test: `server/test/passwordReset.test.js`

**Requirements**

- `POST /api/auth/forgot-password` `{ email }` → **always 202** with the same body regardless of whether the email exists. User enumeration is the thing being prevented; a test must assert the responses for a known and an unknown email are byte-identical.
- The raw token is 32 random bytes from `crypto.randomBytes`, hex-encoded. **Only its SHA-256 hash is stored**, never the raw value — a stolen database must not yield usable reset links.
- Token record: `{ user, tokenHash, expiresAt, usedAt }`. Expiry 15 minutes.
- There is no mail service in the dependency list, so delivery is simulated: the raw token is logged server-side and returned in the response body **only when `NODE_ENV !== 'production'`. Guard this explicitly and say so in the README** — it is the one deliberate lie in the demo.
- `POST /api/auth/reset-password` `{ token, password }` → hashes the incoming token, looks it up, rejects expired (`reset token is invalid or expired`, 400), rejects already-used with the same message, rejects unknown with the same message. All three failure modes return the identical message: distinguishing them leaks token validity.
- On success: bcrypt-hash the new password at cost 10, mark this token used, and **invalidate every other outstanding token for that user**.
- Minimum password length 8, message `password must be at least 8 characters`.
- Compare token hashes with `crypto.timingSafeEqual` where a comparison is done in JS, or rely on the indexed database lookup of the hash; the README must explain which and why.

**Tests (all must exist):** identical response for known and unknown email; a valid token resets the password and the new password logs in; the old password stops working; a used token fails; an expired token fails (insert one with a past `expiresAt`); a second outstanding token is invalidated after the first is used; short password rejected.

**README** — `server/src/passwordReset/README.md`. Concepts to cover: single-use tokens, why hash tokens at rest, expiry windows, user enumeration, uniform error messages, timing attacks, why reset must invalidate sessions (and that this app has none), rate limiting the endpoint (cross-reference the rate-limiting README), never emailing passwords, and why "security questions" are not a reset mechanism.

---

### Task 2: Rate limiting

**Branch:** `feat/rate-limiting`

**Files:**
- Create: `server/src/models/rateLimit.js`
- Create: `server/src/repositories/rateLimits.js`
- Create: `server/src/middleware/rateLimit.js`
- Create: `server/src/rateLimit/README.md`
- Modify: `server/src/app.js` (apply to routes), `server/src/middleware/error.js` only if a `TooManyRequestsError` is needed
- Test: `server/test/rateLimit.test.js`

**Requirements**

- Implement a **sliding-window counter** in MongoDB, atomically: one `findOneAndUpdate` with `$inc` and `upsert`, keyed on `{ key, windowStart }`. No read-then-write race — a test must fire N concurrent requests through `Promise.all` and assert exactly the configured number succeed.
- `rateLimit({ limit, windowMs, keyBy })` returns middleware. `keyBy` is a function of `req` so the same code can key by IP, by account, or by both.
- Apply it as: `POST /api/auth/login` — 5 per minute per IP **and** 5 per minute per email (two limiters, credential stuffing spreads across accounts, brute force concentrates on one); `POST /api/auth/forgot-password` — 3 per hour per email.
- On block: HTTP **429**, body `{ "error": "too many requests" }`, and the headers `Retry-After` (seconds) plus `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`. Successful responses carry the same three `RateLimit-*` headers.
- Documents carry an `expiresAt` field with a TTL index so Mongo evicts old windows; the README must mention that TTL eviction is lazy (up to a minute late) and why that is fine here.
- The limiter must **fail open** if the database errors: a broken counter store must not take authentication down. Test it by stubbing the repository to throw.

**Tests:** the 6th login in a window is blocked; blocking is per-key (a second IP or a second email still passes); the window rolls (advance by manipulating stored `windowStart`, not by sleeping); headers present and correct on both allowed and blocked responses; concurrency test as above; fail-open test.

**README** — `server/src/rateLimit/README.md`. Concepts: fixed window vs sliding window vs sliding log vs token bucket vs leaky bucket, with the burst behaviour of each; where to enforce (edge/CDN, gateway, app) and why multiple layers; what to key on and why IP alone is wrong (NAT, IPv6 prefixes, proxies, `X-Forwarded-For` spoofing); 429 vs 403; `Retry-After` and the `RateLimit-*` header conventions; fail-open vs fail-closed and when each is correct; distributed counters and why Redis is the usual choice; rate limiting vs throttling vs quotas (cross-reference the mern-tickets throttling README).

---

### Task 3: User blocklist

**Branch:** `feat/user-blocklist`

**Files:**
- Create: `server/src/models/blockEntry.js`
- Create: `server/src/repositories/blocks.js`
- Create: `server/src/services/blocks.js`
- Create: `server/src/controllers/blocks.js`
- Create: `server/src/routes/blocks.js`
- Create: `server/src/blocklist/README.md`
- Modify: `server/src/app.js`, `server/src/services/auth.js`, `server/src/services/orders.js`, `server/src/models/user.js`
- Test: `server/test/blocklist.test.js`

**Requirements**

- Two kinds of block, and the README must explain why they are different mechanisms: a **per-user block** (`User.blockedAt`, `User.blockReason`) and a **pattern blocklist** (`BlockEntry { type: 'email' | 'domain', value, reason, createdBy, createdAt }`).
- Email **normalization before matching**: lowercase, trim, strip `+tag` from the local part, and for gmail-style addresses strip dots in the local part. `Demo+spam@Shop.test` must match a block on `demo@shop.test`. Put the normalizer in one exported function and test it directly — evasion is the whole subject.
- Enforcement points: login refuses a blocked user (403, message `account is not available`, deliberately uninformative), and order placement refuses one. A blocked user must not be able to tell blocking apart from a wrong password — the README explains the tradeoff against user experience.
- Admin surface: `POST /api/blocks` and `DELETE /api/blocks/:id`. There are no admin roles in this app, so gate it on a shared secret header `x-admin-token` compared against `process.env.ADMIN_TOKEN`, and say clearly in the README that a header secret is not an authorization system, pointing at the mern-tickets policy README for the real one.
- Every block and unblock writes an audit record (`createdBy`, `createdAt`, `reason`) — blocks must be explainable and reversible.

**Tests:** blocked user cannot log in; the message equals the wrong-password message; normalization matches plus-tags, case, and dots; domain block catches any address at that domain; unblocking restores access; blocked user cannot place an order; admin endpoints reject a missing or wrong token.

**README** — `server/src/blocklist/README.md`. Concepts: block vs suspend vs ban vs shadow-ban; denylist vs allowlist and why allowlists are stronger but rarely usable; identifier normalization and evasion (aliases, disposable domains, homoglyphs); why blocking by IP is weak; audit trails, reversibility, and appeals; not leaking the reason; where blocking sits relative to rate limiting and fraud scoring.

---

### Task 4: Fraud scoring

**Branch:** `feat/fraud-scoring`

**Files:**
- Create: `server/src/fraud/signals.js`, `server/src/fraud/score.js`, `server/src/fraud/README.md`
- Create: `server/src/repositories/orderStats.js` (velocity queries)
- Modify: `server/src/services/orders.js`, `server/src/models/order.js`
- Test: `server/test/fraud.test.js`

**Requirements**

The decision must **not** be a single opaque number. Score is the aggregate, but the decision carries reason codes, and every reason is stored on the order.

- A **signal** is `{ code, weight, triggered, detail }`. Implement at least six, each a small pure function over `{ user, cart, customer, stats }` so they are unit-testable without HTTP or a database:
  - `NEW_ACCOUNT` — account younger than 24h.
  - `ORDER_VELOCITY` — more than 3 orders by this user in the last hour.
  - `HIGH_VALUE` — total above 200.
  - `QUANTITY_ANOMALY` — any line quantity above 10.
  - `EMAIL_MISMATCH` — checkout email differs from the account email.
  - `BLOCKED_DOMAIN` — customer email domain appears in the blocklist (reuses Task 3; if Task 3 is not merged yet, take the domain list from a constant and note it in the README).
- `score(signals)` sums the weights of triggered signals and returns `{ score, decision, reasons }` where decision is `allow` (< 30), `review` (30–69), `deny` (>= 70). Thresholds live in one exported constant.
- Effect on the order: `allow` behaves exactly as today; `review` creates the order with `status: 'review'` and **does not** empty the cart... no — it **does** empty the cart, creates the order held for review, and returns 201 with the order; `deny` creates no order, leaves the cart intact, and returns 403 `order could not be completed`.
- The order stores `fraud: { score, decision, reasons: [code] }`. The API response to the client must **not** include the score or reasons — a test asserts the client-visible payload omits them, and the README explains why exposing a score teaches attackers the model.
- Scoring must be **deterministic**: the same inputs always yield the same decision. A test runs the same order twice and asserts identical scores.

**Tests:** each signal unit-tested in isolation; a clean order scores 0 and is allowed; a new account with a high value lands in review; a denial returns 403, creates no order and leaves the cart intact; the score and reasons are stored but never returned; determinism test.

**README** — `server/src/fraud/README.md`. Concepts: rules engines vs machine learning and why demos and regulated systems start with rules; explainability and reason codes; the three-way allow/review/deny outcome instead of a binary; thresholds as configuration, not code; false positives cost more than they look; review queues and human-in-the-loop; feedback loops and labelling chargebacks; why the score never reaches the client; velocity checks and what state they need; idempotency and replay; adversarial adaptation.

---

## Notes for the executor

- Every new query goes through a repository. No service imports a model; two greps in the layered-server plan enforce this.
- The features are independent — Task 4's `BLOCKED_DOMAIN` signal is the only cross-reference, and it has a documented fallback.
- Where a README claims a file:line, verify it after the code settles.
