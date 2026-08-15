# Plan A — mern-shop: idempotency keys and real sessions

Two topics, same shape as every other in this repo: implementation, tests that fail when the behaviour breaks, and a README beside the code. Copy this file to `mern-shop/docs/superpowers/plans/2026-08-16-idempotency-and-sessions.md` in your first commit.

**Branch:** `feat/shop-idempotency-sessions`. Commit per task, TDD red then green with the real failing output in each red commit body. Do not open a PR.

## Global constraints

- Dependency list for this app becomes: bcrypt, cors, dotenv, express, express-async-errors, mongodb, mongoose, **jsonwebtoken** (newly authorized for Task 2 only), chai, chai-http, mocha, mocha-junit-reporter, mocha-multi-reporters, cross-env. `node:crypto` is built in and allowed. Nothing else.
- No comments in source or tests. No blank lines inside function bodies; test bodies use setup / blank / run / blank / assert.
- ESM, `.js` extensions on relative imports.
- Layering holds: only `repositories/` import models; no `req`/`res` in services or repositories.
- The existing 85 tests must keep passing. Task 2 changes how identity reaches order placement, so tests that post a `userId` will need updating — that is expected and is part of the task, but every change to an existing test must be a genuine consequence of the new identity model, not a weakening of an assertion.
- A red run that aborts before the tests execute is a bad red. Add the minimum stub needed for modules to load so every new test runs and fails on behaviour.
- READMEs use the seven-section shape used everywhere in this repo: What this is / How it works here (real file:line refs) / The core concepts / Standard practice (checklist, one line of why each) / What this toy skips / Try it (runnable curl) / Further reading (six to ten entries, every URL fetched before inclusion).

---

## Task 1 — Idempotency keys

`src/idempotency/` plus a model, repository and middleware.

**The problem being solved:** a client whose request times out cannot know whether the order was placed. It retries. Today that creates a second order. Every payment API in existence solves this with an idempotency key, and this repo references the concept in three READMEs without implementing it.

**Mechanics**

- `POST /api/orders` accepts an `Idempotency-Key` header. Absent, behaviour is unchanged (document that choice; production systems usually require it on money-moving endpoints).
- Stored record: `{ key, user, requestFingerprint, status: 'in_progress' | 'completed', response: { status, body }, createdAt, expiresAt }` with a unique index on `{ key, user }` and a TTL index on `expiresAt` (24h).
- Keys are **scoped per user**. A global key namespace lets one client collide with another's key and read their response; that is a data leak, and the README must say so.
- `requestFingerprint` is a SHA-256 of the canonicalised body. Same key with a different body is a client bug: respond **422** with a clear message rather than silently returning the first response.
- The claim must be **atomic**: one insert of the `in_progress` record wins; a duplicate-key error means someone else got there first. No read-then-write.
  - If the existing record is `completed`, replay its stored response verbatim, with an `Idempotent-Replay: true` header.
  - If it is `in_progress`, the original is still running: respond **409** with `Retry-After`. Do not wait, do not execute.
- On success, store the response and mark `completed` before returning. On a failed request, decide and document: this repo should **release the key** on a 5xx (so a retry can genuinely retry) and **store the response** on a 4xx (a deterministic client error will fail identically). Explain both in the README.

**Tests**

- a replayed key returns the identical body and creates exactly one order;
- the replay carries the replay header and does not touch the cart;
- a second, different key creates a second order;
- same key with a different body is 422;
- a concurrent replay while the first is in flight is 409 (construct both requests, then `Promise.all`);
- keys are scoped: the same key string from another user does not collide;
- a 5xx leaves the key reusable; a 4xx is replayed;
- the fingerprint is insensitive to key order in the JSON body but sensitive to values.

**README** — `src/idempotency/README.md`. Concepts: why at-least-once clients make retries inevitable; idempotent by nature (PUT, DELETE) versus made idempotent (POST with a key); fingerprinting and why it must be checked; scoping and the leak; in-flight handling and why waiting is worse than 409; retention windows; that this is request deduplication, not deduplication of business intent (a user clicking "buy" twice deliberately is a different problem); the relationship to at-least-once delivery elsewhere in this repo — cross-reference `../../../../mern-tickets/server/src/hooks/README.md` and the movies notifications README.

---

## Task 2 — Sessions, rotation, revocation

`src/auth/` extended, plus `src/session/`.

**The hole being closed:** the server currently trusts a client-supplied `userId` at checkout. Anyone can post any id.

**Mechanics**

- Login issues two things: a short-lived **JWT access token** (15 minutes, HS256, signed with `JWT_SECRET`, carrying `sub`, `sid` and `exp`) and a long-lived **opaque refresh token** (32 random bytes, only its SHA-256 hash stored, 30 days).
- Refresh tokens live in a `Session` collection: `{ user, familyId, tokenHash, issuedAt, expiresAt, usedAt, revokedAt, replacedBy }`.
- `POST /api/auth/refresh` **rotates**: the presented token is marked used and a new one issued in the same family. Rotation is the point — a stolen refresh token has a short useful life.
- **Reuse detection:** presenting a refresh token that is already `usedAt` means either an attacker or a buggy client is replaying. Revoke the **entire family** immediately and respond 401. This is the single most important behaviour in the task.
- `POST /api/auth/logout` revokes the family.
- `requireAuth` middleware verifies the access token and puts the user id on the request. **Order placement takes identity from the token and ignores any `userId` in the body** — add a test asserting that a body `userId` for another user is ignored, not honoured.
- Access-token verification must reject: expired, wrong signature, `alg: none`, and a token whose session family has been revoked. The last one is why access tokens are short-lived rather than checked against the database on every request — say that explicitly.

**Tests**

- login returns an access token and a refresh token, and the refresh token is not stored in plaintext;
- the access token authorises order placement, and a body `userId` for a different user is ignored;
- an expired access token is rejected;
- a tampered signature is rejected, and so is `alg: none`;
- refresh rotates: the old token stops working, the new one works;
- **reuse detection**: replaying a rotated token revokes the family, and the previously valid new token stops working too;
- logout revokes: refresh afterwards fails;
- a revoked family cannot be resurrected by an old access token beyond its expiry.

**README** — `src/session/README.md`. Concepts: sessions versus JWTs stated fairly, including that "stateless" is exactly what makes revocation hard; access/refresh split and why the short expiry *is* the revocation window; rotation and reuse detection with token families; storage — httpOnly cookies versus headers, and what each exposes (XSS vs CSRF); why the refresh token is hashed at rest, cross-referencing `../passwordReset/README.md`; `alg: none` and algorithm confusion; key rotation with `kid`; why this repo uses a library rather than hand-rolling JWT; what OAuth2/OIDC add and when you need them. Cross-reference `../rateLimit/README.md` for limiting the login and refresh endpoints, and note whether refresh is currently limited.

---

## Report

Write to `/private/tmp/claude-502/-Users-victor-p-mern/45166ac0-196d-4053-b8d5-e0370ad855fe/scratchpad/shop-idempotency-report.md`: per task, what you built, TDD evidence (red command and real failing output, green command and passing output), the full suite result, every existing test you had to change and why, every link fetched, and any concern. Reply with status, branch, commits, one-line test summary, concerns, report path — under 15 lines.
