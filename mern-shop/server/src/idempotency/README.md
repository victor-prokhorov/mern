# Idempotency keys

## What this is

A mechanism that lets a client safely retry `POST /api/orders` after a timeout or dropped connection without risking a second order. The client generates an `Idempotency-Key`, sends it on the request, and the server guarantees that every request carrying that same key returns the exact same result — the order is created at most once, no matter how many times the request is retried.

## How it works here

1. If the request carries no `Idempotency-Key` header, behaviour is completely unchanged (`middleware/idempotency.js:8-12`): the request runs exactly as it did before this feature existed. This is a deliberate choice, not an oversight — see the core concepts section for why a real money-moving endpoint usually should not leave this optional.
2. If a key is present, the middleware computes the caller's identity via an injected `userIdFrom(req)` function (`middleware/idempotency.js:13`) and a SHA-256 fingerprint of the canonicalised request body (`middleware/idempotency.js:14`, `idempotency/fingerprint.js:14-17`), then tries to **insert** — not upsert — an `in_progress` `IdempotencyKey` document (`middleware/idempotency.js:18`, `repositories/idempotencyKeys.js:3-5`). The compound unique index on `{ key: 1, user: 1 }` (`models/idempotencyKey.js:13`) is what makes this safe: exactly one concurrent insert for a given `(key, user)` pair can succeed, and every other one raises a MongoDB duplicate-key error (code `11000`). There is no read-then-write here — the middleware never checks "does this key already exist?" before inserting; it just inserts and lets the database's own uniqueness constraint decide who got there first, which is the same shape as `repositories/rateLimits.js:5-9`'s atomic upsert, just with `create()` instead of `findOneAndUpdate({ upsert: true })` because ownership here is first-insert-wins rather than shared-counter.
3. When the insert succeeds, the request proceeds to the real controller. The middleware patches `res.json` (`middleware/idempotency.js:42-52`) so that whatever the controller eventually sends is intercepted before it reaches the client: a status `>= 500` releases the claim by deleting the `IdempotencyKey` document (`middleware/idempotency.js:46-47`, `repositories/idempotencyKeys.js:16-17`) so the same key can be claimed again; anything else — 2xx or 4xx alike — stores the exact status and body and marks the record `completed` (`middleware/idempotency.js:48-49`, `repositories/idempotencyKeys.js:11-13`). The stored body is round-tripped through `JSON.parse(JSON.stringify(body))` (`middleware/idempotency.js:45`) before being written to the `Mixed` field, so a later replay reproduces byte-for-byte what `res.json` would have serialized the first time — including Mongoose documents' own `toJSON` transforms (`models/order.js:31-37` strips `fraud` and `__v`), not whatever internal shape the document happens to hold in memory.
4. When the insert fails with `11000`, the middleware looks up the existing record for that `(key, user)` pair (`middleware/idempotency.js:24`) and checks the stored fingerprint first, before status: a mismatched fingerprint is a client bug — same key, different request — and gets `422` regardless of whether the original request is still running or already finished (`middleware/idempotency.js:29-31`). Only once the fingerprint matches does status matter: `in_progress` means the original request has not finished yet, so the middleware responds `409` with `Retry-After: 1` and does **not** wait for it (`middleware/idempotency.js:33-36`); `completed` means it has, so the middleware replays the stored status and body verbatim with an `Idempotent-Replay: true` header (`middleware/idempotency.js:38-39`).
5. `routes/orders.js:7` wires `idempotency({ userIdFrom: (req) => req.body.userId })` in front of `orders.place`. That `userIdFrom` extraction is exactly why this repository's `src/session/README.md` matters to this file: the moment identity stops living in `req.body.userId`, this line has to change with it (see that README's note on the consequence this had here).

## The core concepts

- **At-least-once clients make retries inevitable.** A client that sends a request and never receives a response cannot distinguish "the server never got it" from "the server processed it and the reply was lost." The only two honest choices are: never retry (and leave the user stuck on a network blip), or retry and make retries safe. Idempotency keys are what makes the second choice viable for an operation — creating an order — that is not naturally safe to repeat.
- **Idempotent by nature vs. made idempotent.** RFC 9110 defines `PUT`, `DELETE`, `GET`, and `HEAD` as idempotent by nature: "the intended effect on the server of multiple identical requests ... is the same as the effect for a single such request." `POST /api/orders` is not naturally idempotent — two identical `POST`s create two orders — so idempotency here is manufactured with a client-supplied key rather than inherent to the method.
- **Fingerprinting exists so the key can't lie.** Without checking that the body matches, a client could send `Idempotency-Key: abc` with a $5 order, then reuse `abc` with a $500 order and silently get back the $5 order's result — or worse, if the second request were allowed to execute, the key would stop meaning "this exact operation" and start meaning nothing. Stripe's own docs are explicit that the idempotency layer "compares incoming parameters to those of the original request and errors if they're not the same." This implementation checks that before anything else.
- **Scoping and the leak this prevents.** The unique index is on `{ key, user }`, not `{ key }` alone. If keys were global, a client could guess or intercept another user's `Idempotency-Key` string and, on collision, receive that user's stored response — an order confirmation, its total, its customer details — as their own reply. Scoping by user turns "guess someone's key" from a data leak into a no-op: the guesser's own claim attempt for `{ key, otherUser }` simply doesn't collide with `{ key, thatUser }` at all, because the compound index treats them as entirely different documents.
- **Why 409 and not waiting.** An in-progress duplicate could, in principle, have the second request block until the first resolves and then return its result. This implementation deliberately does not: waiting ties up a server connection for however long the original request takes, turns one slow request into two, and gives no way for the caller to know how long is reasonable to wait. Responding `409 Retry-After: 1` immediately puts the decision back where it belongs — with the caller — and costs the server nothing beyond the lookup it already had to do.
- **Retention windows.** `expiresAt` is 24 hours from claim (`middleware/idempotency.js:4,15`), enforced by a MongoDB TTL index (`models/idempotencyKey.js:10`, `expires: 0`, meaning "expire exactly at the stored `expiresAt` moment"). This matches Stripe's own stated window — "remove keys from the system automatically after they're at least 24 hours old" — and the same caveat from `rateLimit/README.md` applies: TTL deletion is a background sweep that runs roughly once a minute, not an instant guarantee, so a key can outlive `expiresAt` by up to that sweep interval before it is physically removed. That laziness never causes incorrect behaviour, only a delay in reclaiming storage: nothing here reads a document by "is it expired," only by `(key, user)`.
- **Request deduplication is not business-intent deduplication.** This feature stops the *same request* from executing twice. It does nothing about a user who deliberately clicks "place order" twice in two browser tabs with two different keys — that is two different requests expressing the same underlying intent, and preventing it (if it should be prevented at all) is a product decision about duplicate orders, not a retry-safety problem. Conflating the two leads to systems that either block legitimate repeat purchases or fail to protect against a client bug that resends the same request forever.
- **The same idea, from the two other angles already in this monorepo.** `mern-tickets/server/src/hooks/README.md` argues idempotency from the *rejection* side — a pipeline that runs at most once and treats a resubmission as an error to reject rather than a request to replay — and is explicit that its own `duplicateContentHandler` is a content-dedup spam filter, not a real idempotency mechanism, because it has no key and no stored result. `mern-movies/server/src/notifications/README.md` shows the same unique-index-as-dedupe trick used here, but for making a fan-out handler safe to *re-run* rather than making an HTTP endpoint safe to *retry* — a natural composite key (`{ user, movie, actor }`) instead of a client-supplied one. All three are the same underlying idea — let the database's uniqueness guarantee answer "did this already happen?" — applied to three different problems.

## Standard practice

- Take a client-generated key and store the first result (status + body) under it, replaying it verbatim for every retry — Stripe's own description is the reference: "saving the resulting status code and body of the first request ... regardless of whether it succeeds or fails."
- Claim the key with a single atomic insert against a unique constraint, never a read-then-write — a check-then-insert has a race window where two concurrent requests both see "not claimed yet" and both proceed.
- Scope the key to the caller, not globally — an unscoped key namespace lets one client's guess collide with another client's stored response.
- Fingerprint the request body and reject a same-key-different-body request distinctly from a genuine retry — otherwise the key silently stops meaning what the client thinks it means.
- Respond immediately (409, not a wait) to a request whose duplicate is still in flight — waiting turns one slow request into two and takes the retry decision away from the caller.
- Prune keys after a bounded retention window with a TTL index or equivalent reaper — an idempotency store that never expires grows without bound and eventually becomes its own storage problem.
- Decide, and document, what happens to the claim on failure — this app releases the key on 5xx (network/server errors are exactly what a client should retry against a fresh attempt) and stores the response on 4xx (a deterministic client error — bad input, business rule violation — will fail identically on retry, so replaying it is both correct and cheaper than re-running the whole request).
- Require the key on endpoints where a duplicate write has real cost (payments, order placement) rather than treating it as always-optional — see below for why this app does the opposite and what that costs.

## What this toy skips

- **The header is optional here, and a real payment API usually would not make it so.** `middleware/idempotency.js:8-12` lets a request with no `Idempotency-Key` through unchanged, meaning a client that forgets the header gets zero protection and a naive retry still creates a second order. Stripe and most production payment APIs make the header effectively mandatory on money-moving endpoints — some reject requests without one outright — precisely because "the client remembered to opt in" is not a safety property. This app makes it optional to keep the demo's existing tests (which predate this feature and don't send the header) working unchanged; a real deployment protecting an endpoint this sensitive should not offer that escape hatch.
- No idempotency key support on any endpoint besides order placement — cart mutations, for instance, have no equivalent protection.
- No enumeration of "concurrent request while claiming" beyond the duplicate-key path — a claim that fails for a reason other than `11000` (a genuine database outage, say) is passed to `next(err)` and surfaces as a 500 with no retry guidance specific to this feature.
- No backoff or jitter guidance in the `409` response beyond a flat `Retry-After: 1` — a real client-facing contract would likely want this tuned to the endpoint's typical latency.
- No admin visibility into stored idempotency records — there's no endpoint to inspect, list, or manually expire a key, which an operator debugging a stuck client would want.
- The fingerprint canonicalises key order and nested objects/arrays but has no defined behaviour for values whose JSON serialization is inherently unstable (e.g. `NaN`, `undefined` inside an array) — this app's request bodies don't exercise that edge, so it's untested here.

## Try it

With the dev server running (`npm run dev`), seed data loaded, and a valid user id and cart in place, place an order with an idempotency key:

```bash
curl -i -X POST http://localhost:5000/api/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-key-1' \
  -d '{"cartId":"<a cart id with items>","userId":"<a seeded user id>","customer":{"name":"Ada","email":"ada@shop.test","address":"1 Main Street"}}'
```

Note the `_id` in the response, then repeat the exact same request:

```bash
curl -i -X POST http://localhost:5000/api/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-key-1' \
  -d '{"cartId":"<the same cart id>","userId":"<the same user id>","customer":{"name":"Ada","email":"ada@shop.test","address":"1 Main Street"}}'
```

The second response carries `Idempotent-Replay: true` and the identical `_id` — no second order was created. Now send the same key with a different body:

```bash
curl -i -X POST http://localhost:5000/api/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-key-1' \
  -d '{"cartId":"<the same cart id>","userId":"<the same user id>","customer":{"name":"Bea","email":"bea@shop.test","address":"1 Main Street"}}'
```

That returns `422`. Finally, fire two identical requests with a fresh key at the same instant to see the in-flight `409`:

```bash
curl -i -X POST http://localhost:5000/api/orders -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-key-2' -d '{"cartId":"<cart id>","userId":"<user id>","customer":{"name":"Ada","email":"ada@shop.test","address":"1 Main Street"}}' & \
curl -i -X POST http://localhost:5000/api/orders -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-key-2' -d '{"cartId":"<cart id>","userId":"<user id>","customer":{"name":"Ada","email":"ada@shop.test","address":"1 Main Street"}}'
```

One prints `201`, the other `409` with `Retry-After: 1` — whichever wins the race with the database.

## Further reading

- [Stripe API reference, Idempotent requests](https://docs.stripe.com/api/idempotent_requests) — the reference implementation this design follows: first result stored (success or failure), replayed on retry, parameter mismatch is an error, keys pruned after roughly 24 hours.
- [Brandur Leach, Implementing Stripe-like idempotency keys in Postgres](https://brandur.org/idempotency-keys) — the deepest public write-up of the mechanics: an atomic claim via a unique constraint, a recovery-point state machine for multi-step operations, and a reaper for expired keys. This app's claim/replay/release shape is a simplified version of the same idea.
- [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) — the attempt to standardize the `Idempotency-Key` header. Worth reading with the caveat this README states plainly: the draft expired without becoming an RFC, so this is a widely copied vendor convention, not a standard.
- [RFC 9110 §9.2.2, Idempotent Methods](https://httpwg.org/specs/rfc9110.html#idempotent.methods) — the formal definition of "idempotent by nature," and the reason `POST` needs a bolted-on mechanism that `PUT`/`DELETE` get for free.
- [MongoDB: Unique Indexes](https://www.mongodb.com/docs/manual/core/index-unique/) — the exact guarantee the atomic claim rests on: "a unique compound index ensures that any given combination of the index key values appears at most once."
- [MongoDB: TTL Indexes](https://www.mongodb.com/docs/manual/core/index-ttl/) — the retention mechanism, including the roughly-60-second background sweep and the explicit statement that expiry is not instant deletion.
- [`../../../../mern-tickets/server/src/hooks/README.md`](../../../../mern-tickets/server/src/hooks/README.md) — the same concept from the rejection side: a pipeline that runs at most once and treats a resubmission as an error, plus an honest accounting of why its own content-dedup handler is not actually an idempotency mechanism.
- [`../../../../mern-movies/server/src/notifications/README.md`](../../../../mern-movies/server/src/notifications/README.md) — the same unique-index-as-dedupe trick used to make a fan-out handler safely re-runnable, with a natural composite key instead of a client-supplied one.
- [`../rateLimit/README.md`](../rateLimit/README.md) — the atomic-upsert pattern this feature's claim step is modelled on, and the sibling case (a shared counter) where the retry-after-duplicate-key-error path differs from this file's insert-and-fail-fast approach.
- [`../session/README.md`](../session/README.md) — why `userIdFrom` in `routes/orders.js:7` changes from reading `req.body.userId` to `req.userId`, and what that consequence looked like in this app's tests.
