# Rate limiting

## What this is

A mechanism that caps how many times a client can hit an endpoint in a given time window, to blunt brute force, credential stuffing, and scraping. This implementation is a fixed window counter backed by MongoDB, applied to login and password-reset requests.

## How it works here

1. `middleware/rateLimit.js:3` exports a factory, `rateLimit({ limit, windowMs, keyBy, store })`, that returns Express middleware. `keyBy(req)` computes the counter's key from the request, so the same middleware can key by IP, by account, or by anything else derivable from `req`.
2. On each request the middleware buckets the current time into a fixed window: `windowStart = Math.floor(now / windowMs) * windowMs` (`middleware/rateLimit.js:7`). Every request inside the same `windowMs`-sized slice shares one counter document.
3. It calls `store.incrementWindow(key, windowStart, expiresAt)` (`middleware/rateLimit.js:11`), which does one atomic `findOneAndUpdate` with `$inc: { count: 1 }` and `upsert: true` (`repositories/rateLimits.js:5-9`), keyed on the compound `{ key, windowStart }`. There is no read-then-write: the increment and the "does this window exist yet" check happen as a single database operation, so concurrent requests cannot race each other into under-counting.
4. Concurrent upserts on a brand-new `{ key, windowStart }` pair can still collide at the database level and raise a duplicate-key error (code `11000`) if two requests both try to insert the first document for that window at the same instant. The repository catches that specific error and retries the same `findOneAndUpdate` once (`repositories/rateLimits.js:10-16`); the retry is now a plain update against a row that exists, so it always succeeds.
5. The middleware reads `doc.count` back, computes remaining budget and seconds until the window resets, and always sets `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (`middleware/rateLimit.js:18-20`) — on allowed responses and blocked ones alike. If `doc.count` exceeds `limit`, it adds `Retry-After` and responds `429 { "error": "too many requests" }` (`middleware/rateLimit.js:21-24`); otherwise it calls `next()`.
6. `models/rateLimit.js:7` gives each counter document an `expiresAt` with `expires: 0`, a MongoDB TTL index that deletes the document once the current time passes `expiresAt` — so old windows are garbage collected without any application code doing cleanup. MongoDB's TTL background task only sweeps for expired documents roughly once every 60 seconds, so a document can sit in the collection up to a minute past its `expiresAt` before it is actually deleted. That lag never causes incorrect rate limiting: the middleware always looks up a document by the *current* `windowStart`, so a stale, not-yet-deleted document from an old window is simply never read again regardless of whether it has been physically removed yet. The laziness only delays reclaiming storage, not correctness.
7. `app.js:14-17` wires four limiter instances: 5 requests/minute keyed by IP for login, 5/minute keyed by the submitted email for login, 3/hour keyed by email for `forgot-password`, and 10/hour keyed by IP for `reset-password`. `app.js:22-24` applies them as route-scoped middleware before the real routers are mounted. The `reset-password` limit is deliberately looser and IP-only rather than credential-keyed: the token being checked is a 256-bit random value, so the limiter there is resource protection (stop one IP from hammering the endpoint with junk requests) rather than credential protection (there is no realistic brute force of a 256-bit token to defend against).
8. `middleware/rateLimit.js:3` also accepts an injectable `store`, defaulted to the real repository. If `store.incrementWindow` throws for any reason (a real outage, or an injected stub in tests), the middleware's `catch` calls `next()` and returns without setting any rate-limit headers (`middleware/rateLimit.js:12-15`) — the request passes through unlimited rather than the entire auth surface going down because the counter store is unavailable.

## The core concepts

- **Fixed window**: time is sliced into non-overlapping buckets (e.g. every wall-clock minute); a counter belongs to exactly one bucket.
- **Sliding window (log)**: instead of hard buckets, a timestamp is recorded per request and the count is "requests in the last `windowMs`, ending now" — smoother, but requires storing every timestamp.
- **Sliding window counter**: a compromise — keep fixed buckets, but weight the previous bucket's count by how much of it still overlaps the current `windowMs` lookback. This repo implements the fixed-window variant (bucket = `keyBy` + `windowStart`), not the weighted sliding-window-counter blend; the README's title matches the plan's terminology but the mechanism is a fixed window per key, which is the same primitive most rate limiters actually ship.
- **Token bucket**: a bucket refills at a steady rate and each request spends one token; once empty, requests wait or fail. Naturally allows a burst up to the bucket size, then throttles to the refill rate.
- **Leaky bucket**: requests queue and are processed (or dropped) at a constant rate, smoothing bursts into a steady drip instead of allowing them.
- **Fail open vs fail closed**: on an internal error, fail open lets the request through (favors availability), fail closed blocks it (favors strict enforcement). Auth rate limiting should fail open — a broken counter store must not become an outage for every login.
- **Distributed counter**: when an app runs on multiple instances, the counter must live somewhere all instances share (a database, Redis) rather than in one process's memory, or each instance enforces its own separate, looser limit.

## Standard practice

- Enforce limits at more than one layer (CDN/edge, API gateway, application) — each layer stops a different class of abuse and one being misconfigured doesn't remove all protection.
- Key on more than IP alone — NAT and shared corporate/mobile-carrier IPs put many legitimate users behind one address, IPv6 gives each client a nearly unlimited pool of addresses to rotate through, and `X-Forwarded-For` is trivially spoofed by a client talking directly to your server (it's only trustworthy once a trusted proxy sets it and strips any client-supplied value first).
- Key credential-sensitive endpoints on the credential too (here: email), not just IP — credential stuffing spreads one attempt per account across thousands of IPs, so an IP-only limiter never trips; brute force concentrates on one account, so an email-only limiter never trips either. This app runs both limiters on login simultaneously. Keying by email is not free, though: the email in a login request is attacker-supplied, not authenticated, so anyone who knows (or guesses) a victim's email can send 5 failing requests from anywhere and lock that victim out of their own account for the rest of the window — a targeted account-lockout denial-of-service that costs the attacker nothing. A reader has to weigh this against the credential-stuffing protection it buys; production systems typically mitigate it with a higher email-keyed threshold than the IP-keyed one, CAPTCHA after a few failures instead of an outright block, or alerting a real user whose account is being hammered rather than silently locking them out.
- Return `429 Too Many Requests`, not `403 Forbidden` — 403 says "you are not allowed to have this, ever"; 429 says "you are allowed, just not right now," which is the actual state and lets clients retry correctly.
- Send `Retry-After` (seconds until the client should try again) and the `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers (the IETF draft convention this repo follows) on every response, not just blocked ones — well-behaved clients back off proactively instead of hammering the limit repeatedly.
- Prefer failing open on limiter-store errors for authentication-adjacent endpoints — the limiter is a defense-in-depth layer, not the primary access control; losing it temporarily is safer than losing login for every legitimate user.
- Use TTL indexes (or an equivalent background reaper) to expire old window documents automatically — a limiter that never cleans up its own storage becomes its own denial-of-service target over time.
- Reach for Redis (or a similar in-memory store) for production-scale distributed counters — Mongo's atomic `findOneAndUpdate` works for a teaching demo and moderate traffic, but Redis's `INCR`/`EXPIRE` primitives are purpose-built for this, sub-millisecond, and don't compete with the primary database's write capacity during an attack (which is exactly when you need the limiter most).
- Distinguish rate limiting (protects the system, short windows, hard rejects) from throttling (slows a client down, e.g. delayed responses or reduced concurrency, without necessarily rejecting) from quotas (a longer-horizon allowance, e.g. "1000 calls per day," usually a business/billing control rather than an abuse control) — see the throttling README in the mern-tickets app for the throttling side of that distinction.

## What this toy skips

- No edge/CDN or gateway layer — everything enforces in the Node process, which is the weakest place to do it (an attacker's request still costs a full round trip and a database write before being rejected).
- No Redis; MongoDB is used to keep the dependency list unchanged, at the cost of higher write load on the primary database under attack.
- No true sliding-window-log or weighted sliding-window-counter smoothing — this is a plain fixed window per key, so a client can send `limit` requests at the very end of one window and another `limit` at the very start of the next, briefly exceeding the intended rate near window boundaries.
- No per-user configuration or tiered limits (e.g. higher limits for paying customers, admin bypass).
- No global/account-wide circuit breaker across endpoints — each limiter instance is independent, so a client blocked on login can still hit forgot-password freely.
- No metrics or alerting on sustained blocking, which in production is exactly the signal that an attack is underway.

## Try it

With the dev server running (`npm run dev`) and seed data loaded, exceed the login limit:

```bash
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5000/api/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"demo@shop.test","password":"wrong"}'
done
```

The first five print `401`; the sixth prints `429`. Inspect the headers on any response:

```bash
curl -i -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@shop.test","password":"wrong"}'
```

Look for `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and, once blocked, `Retry-After`.
