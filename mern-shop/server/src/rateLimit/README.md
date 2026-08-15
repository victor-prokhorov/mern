# Rate limiting

## What this is

A mechanism that caps how many times a client can hit an endpoint in a given time window, to blunt brute force, credential stuffing, and scraping. This implementation is a fixed window counter backed by MongoDB, applied to login and password-reset requests.

## How it works here

1. `middleware/rateLimit.js:3` exports a factory, `rateLimit({ limit, windowMs, keyBy, store })`, that returns Express middleware. `keyBy(req)` computes the counter's key from the request, so the same middleware can key by IP, by account, or by anything else derivable from `req`.
2. On each request the middleware buckets the current time into a fixed window: `windowStart = Math.floor(now / windowMs) * windowMs` (`middleware/rateLimit.js:7`). Every request inside the same `windowMs`-sized slice shares one counter document.
3. It calls `store.incrementWindow(key, windowStart, expiresAt)` (`middleware/rateLimit.js:11`), which does one atomic `findOneAndUpdate` with `$inc: { count: 1 }` and `upsert: true` (`repositories/rateLimits.js:5-9`), keyed on the compound `{ key, windowStart }`. There is no read-then-write: the increment and the "does this window exist yet" check happen as a single database operation, so concurrent requests cannot race each other into under-counting.
4. Concurrent upserts on a brand-new `{ key, windowStart }` pair can still collide at the database level and raise a duplicate-key error (code `11000`) if two requests both try to insert the first document for that window at the same instant. This is documented MongoDB behaviour, not a quirk: with a unique index in place, exactly one concurrent upsert inserts and the others "either update the newly-inserted document or fail due to a unique key collision". The repository catches that specific error and retries the same `findOneAndUpdate` once (`repositories/rateLimits.js:10-17`); the retry is now a plain update against a document that exists, so it always succeeds.
5. The middleware reads `doc.count` back and computes the remaining budget and the seconds until the window resets. It then sets `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (`middleware/rateLimit.js:20-24`) on allowed and blocked responses alike — but only if this limiter is the most restrictive one seen so far on this response, which is what the next section is about. If `doc.count` exceeds `limit`, it adds `Retry-After` and responds `429 { "error": "too many requests" }` (`middleware/rateLimit.js:25-29`); otherwise it calls `next()`. **These three header names are the syntax of an obsolete draft, not of the current one** — see the note below.
6. `models/rateLimit.js:7` gives each counter document an `expiresAt` with `expires: 0`, a MongoDB TTL index that deletes the document once the current time passes `expiresAt` — so old windows are garbage collected without any application code doing cleanup. MongoDB's TTL background task sweeps for expired documents every 60 seconds and the sweep is single-threaded, so a document can sit in the collection a minute past its `expiresAt` — or longer, under load — before it is actually deleted. That lag never causes incorrect rate limiting: the middleware always looks up a document by the *current* `windowStart`, so a stale, not-yet-deleted document from an old window is simply never read again regardless of whether it has been physically removed yet. The laziness only delays reclaiming storage, not correctness.
7. `app.js:14-17` wires four limiter instances: 5 requests/minute keyed by IP for login, 5/minute keyed by the submitted email for login, 3/hour keyed by email for `forgot-password`, and 10/hour keyed by IP for `reset-password`. `app.js:22-24` applies them as route-scoped middleware before the real routers are mounted. The `reset-password` limit is deliberately looser and IP-only rather than credential-keyed: the token being checked is a 256-bit random value, so the limiter there is resource protection (stop one IP from hammering the endpoint with junk requests) rather than credential protection (there is no realistic brute force of a 256-bit token to defend against).
8. `middleware/rateLimit.js:3` also accepts an injectable `store`, defaulted to the real repository. If `store.incrementWindow` throws for any reason (a real outage, or an injected stub in tests), the middleware's `catch` calls `next()` and returns without setting any rate-limit headers (`middleware/rateLimit.js:12-15`) — the request passes through unlimited rather than the entire auth surface going down because the counter store is unavailable. Note that the error is swallowed silently: nothing is logged and no metric is emitted, so a permanently broken counter store looks exactly like normal traffic from the outside.

**What the response headers actually say, and what they do not.** The header names this middleware emits — `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, each carrying a bare integer — are the syntax of `draft-ietf-httpapi-ratelimit-headers-05` (July 2022). That syntax no longer exists in the specification. The current revision, `-11` (23 May 2026), is still an active Internet-Draft on the Standards Track and has still not been published as an RFC, but it replaced the three-header form with two RFC 9651 structured fields:

- `RateLimit-Policy`, advertising the quota policy: `q` (quota, required), `qu` (quota unit, default `requests`), `w` (window in seconds), `pk` (partition key).
- `RateLimit`, reporting current state: `r` (remaining quota, required), `t` (seconds left in the effective window), `pk`.

So a spec-conformant version of what this middleware emits for the login limiter would be roughly `RateLimit-Policy: "login";q=5;w=60` and `RateLimit: "login";r=4;t=21`, not three separate integer-valued fields. **This code is not conformant with the current draft and this README does not claim it is.** The older spelling is still the one most deployments emit — `express-rate-limit`, the default choice for this stack, calls it `draft-6` and still uses it when `standardHeaders` is set to `true`, with the combined form available as `draft-7` and `draft-8` — so a demo emitting it is not an outlier. But that is a reason to name the version you implement, not a reason to leave it unstated. Anything you deploy for real should pick deliberately and say which it picked, because "we send the standard rate limit headers" now identifies at least three mutually incompatible wire formats.

**Reporting the binding limiter: a limiter may only lower `RateLimit-Remaining`.** More than one limiter can apply to a single route — login runs two (`app.js:22`), one keyed by IP and one by the submitted email. The naive implementation has each of them call `res.set(...)` unconditionally, which means the response describes whichever limiter happened to run last rather than whichever one is closest to rejecting the request. That is worse than emitting no headers at all: a well-behaved client pacing itself off `RateLimit-Remaining` is handed a number that is too high and walks straight into a 429 it was trying to avoid.

So each limiter here reads the value already on the response and rewrites the triple only when its own remaining budget is strictly smaller (`middleware/rateLimit.js:20-24`). The effect is that `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` always describe one coherent policy — the most restrictive one applied to the route — instead of three fields blended from different limiters. A limiter that is rejecting the request always writes its own triple regardless, because the limiter returning the 429 is by definition the binding one and its `Retry-After` has to match the window it reports.

The reasoning generalises past this codebase: **the client can act on one number.** There is no useful way for a caller to consume "you have 4 left under one policy and 1 under another" from three scalar fields, so the server has to do the reduction, and the only safe reduction is the minimum. This is also the limitation that motivated the current draft's design — `RateLimit-Policy` is a List precisely so a server can name several policies and report each one's state separately, instead of collapsing them and losing the detail. Emitting the older three-field form means accepting the collapse; the least you can do is collapse in the direction that cannot mislead.

You can watch the difference. In a fresh window, send three login attempts as `a@shop.test`, then one as `b@shop.test`. The IP-keyed counter is now at 4 of 5 and the email-keyed counter for `b@shop.test` is at 1 of 5, so the response reports `RateLimit-Remaining: 1` — the IP-keyed figure, which is the one that will actually block the next request. Before this behaviour existed it reported `4`. The `Try it` section below reproduces both halves, and `test/rateLimit.test.js` pins it in two tests: one on the real login route, one on a pair of stacked limiters mounted in both orders, so the result cannot depend on which limiter runs first.

**Two normalizations for one email.** The limiter keys built in `app.js:15-16` normalize the submitted address with nothing but `.toLowerCase()`, while the blocklist normalizes with `normalizeEmail` (`services/blocks.js:7-17`), which also strips `+tags` and, for Gmail-family domains, dots. Two definitions of "the same email address" in one codebase is exactly the drift the fraud README warns about; here it happens to fail safe, because `users.findByEmail` is itself an exact match and an aliased address finds no account at all. In a system whose user lookup *did* normalize, the weaker limiter key would hand an attacker a fresh quota per alias.

## The core concepts

The five algorithms below differ mainly in one thing: what burst they let through, and what they cost to store. That is the axis to compare them on.

- **Fixed window**: time is sliced into non-overlapping buckets (e.g. every wall-clock minute); a counter belongs to exactly one bucket. One integer per key. **Burst: up to 2× the limit**, since a client can spend a full window's budget in the last instant of one bucket and a second full budget in the first instant of the next.
- **Sliding window (log)**: instead of hard buckets, a timestamp is recorded per request and the count is "requests in the last `windowMs`, ending now". **Burst: none — it is exact**, and it is the only one of these that is. The price is storing (and trimming) one timestamp per request per key, which is O(limit) memory and the reason it is rarely what ships at scale.
- **Sliding window counter**: a compromise — keep fixed buckets, but weight the previous bucket's count by how much of it still overlaps the current lookback: `rate = previous × (windowMs − elapsed) / windowMs + current`. Two integers per key, and **burst is bounded well below 2×** because the previous window's spend is still being charged against you as it ages out. It assumes requests were spread evenly across the previous bucket, so it is an approximation — Cloudflare measured it wrong on 0.003% of 400 million requests, which is the honest way to state the tradeoff. This repo implements the plain fixed-window variant (bucket = `keyBy` + `windowStart`), not this weighted blend.
- **Token bucket**: a bucket of capacity `B` refills at `r` tokens per second and each request spends one; once empty, requests wait or fail. **Burst: up to `B` requests instantly**, then a hard ceiling of the refill rate `r` — burst size and sustained rate are two separate dials, which is the reason it is the default choice for public APIs (Stripe's request rate limiter is a token bucket). The throttle in `mern-tickets` is a persisted token bucket, so it is the concrete counter-example to this file.
- **Leaky bucket**: worth splitting in two, because the name covers two different mechanisms. *As a queue*: requests are buffered and drained at a constant rate, so bursts are absorbed into latency rather than rejection — no burst reaches the backend, but a queue means unbounded waiting and stale requests. *As a meter*: no queue, just a counter that drains at a constant rate and rejects anything that would overflow — which is arithmetically the mirror image of the token bucket and behaves identically.
- **GCRA (generic cell rate algorithm)**: the leaky-bucket meter rewritten to need no background drip at all. Rather than a counter someone must decrement on a timer, it stores a single timestamp per key — the theoretical arrival time (TAT), the earliest instant at which the next request would be conforming — and admits a request if now is no earlier than `TAT − burst_tolerance`. **Burst: bounded by the tolerance parameter**, sustained rate by the emission interval, same two dials as a token bucket. Because there is no drip process, there is nothing to fail independently of the request path, which is why it is the algorithm behind `redis-cell` and most serious Redis-backed limiters. It comes from ATM traffic policing, not from web APIs.
- **Fail open vs fail closed**: on an internal error, fail open lets the request through (favors availability), fail closed blocks it (favors strict enforcement). Auth rate limiting should fail open — a broken counter store must not become an outage for every login — but it must also be *loud*, which is where this implementation falls short (see above).
- **Distributed counter**: when an app runs on multiple instances, the counter must live somewhere all instances share (a database, Redis) rather than in one process's memory, or each instance enforces its own separate, looser limit — N instances means an effective limit of N × `limit`.

## Standard practice

- Enforce limits at more than one layer (CDN/edge, API gateway, application) — each layer stops a different class of abuse and one being misconfigured doesn't remove all protection.
- Key on more than IP alone — NAT and shared corporate/mobile-carrier IPs put many legitimate users behind one address, IPv6 gives each client a nearly unlimited pool of addresses to rotate through, and credential-stuffing toolkits route through proxy networks specifically so that per-IP volume stays low enough to slip under an IP limiter. Forwarding headers are no help by themselves: RFC 7239 says outright that they "cannot be relied upon to be correct, as [they] may be modified, whether mistakenly or for malicious reasons, by every node on the way to the server, including the client making the request". They are only trustworthy once a trusted proxy sets them and strips any client-supplied value first. In Express that means setting `trust proxy` to match your actual proxy topology; this app never sets it, so `req.ip` here is the raw socket address and `X-Forwarded-For` is ignored — the correct default for a server with nothing in front of it, and the wrong one the moment you put a load balancer there.
- Key credential-sensitive endpoints on the credential too (here: email), not just IP — credential stuffing spreads one attempt per account across thousands of IPs, so an IP-only limiter never trips; brute force concentrates on one account, so an email-only limiter never trips either. This app runs both limiters on login simultaneously. Keying by email is not free, though: the email in a login request is attacker-supplied, not authenticated, so anyone who knows (or guesses) a victim's email can send 5 failing requests from anywhere and lock that victim out of their own account for the rest of the window — a targeted account-lockout denial-of-service that costs the attacker nothing. A reader has to weigh this against the credential-stuffing protection it buys; production systems typically mitigate it with a higher email-keyed threshold than the IP-keyed one, CAPTCHA after a few failures instead of an outright block, or alerting a real user whose account is being hammered rather than silently locking them out.
- Return `429 Too Many Requests`, not `403 Forbidden` — 403 says "you are not allowed to have this, ever"; 429 says "you are allowed, just not right now," which is the actual state and lets clients retry correctly. 429 is defined in RFC 6585 §4 (April 2012), which is where the "MAY include a Retry-After header" permission for it comes from; note that plenty of large APIs still get this wrong, GitHub included, which documents returning "a `403` or `429`" for the same condition.
- Send `Retry-After` on blocked responses and quota headers on every response, not just blocked ones — well-behaved clients back off proactively instead of hammering the limit repeatedly. `Retry-After` itself is RFC 9110 §10.2.3, whose value is either an HTTP-date or a delay in seconds; RFC 9110 only discusses it in the context of 503 and 3xx, so the pairing with 429 rests on RFC 6585. For the quota headers, pick a spelling deliberately and say which: the current `RateLimit`/`RateLimit-Policy` structured fields from the IETF draft, the obsolete `RateLimit-*` triple this repo emits, or a vendor convention such as GitHub's `x-ratelimit-*`. The one thing not to do is emit one spelling and describe another.
- Report the binding limit, not the last one computed — when several limiters stack on one route, the numbers a client sees must reflect whichever is closest to rejecting it, because the client can only act on one number. A limiter must be able to lower `RateLimit-Remaining` and never raise it. Headers that overstate the remaining budget actively mislead the well-behaved clients they exist to help, which is worse than sending nothing.
- Prefer failing open on limiter-store errors for authentication-adjacent endpoints — the limiter is a defense-in-depth layer, not the primary access control; losing it temporarily is safer than losing login for every legitimate user.
- Use TTL indexes (or an equivalent background reaper) to expire old window documents automatically — a limiter that never cleans up its own storage becomes its own denial-of-service target over time.
- Reach for Redis (or a similar in-memory store) for production-scale distributed counters — Mongo's atomic `findOneAndUpdate` works for a teaching demo and moderate traffic, but Redis's `INCR`/`EXPIRE` primitives are purpose-built for this, sub-millisecond, and don't compete with the primary database's write capacity during an attack (which is exactly when you need the limiter most).
- Cap total failed attempts per credential, not only the rate — NIST SP 800-63B-4 §3.2.2 requires verifiers to "limit consecutive failed authentication attempts using a specific authenticator on a single subscriber account to no more than 100 by disabling that authenticator". A per-minute limiter satisfies no such cap on its own: 5 per minute is 7,200 attempts a day against one account, all of them within policy.
- Distinguish rate limiting (protects the system, short windows, hard rejects) from throttling (slows a client down, e.g. delayed responses or reduced concurrency, without necessarily rejecting) from quotas (a longer-horizon allowance, e.g. "1000 calls per day," usually a business/billing control rather than an abuse control) — see [`mern-tickets/server/src/throttle/README.md`](../../../../mern-tickets/server/src/throttle/README.md) for the throttling side of that distinction, implemented there as a persisted token bucket per user per action.

## What this toy skips

- No edge/CDN or gateway layer — everything enforces in the Node process, which is the weakest place to do it (an attacker's request still costs a full round trip and a database write before being rejected).
- No Redis; MongoDB is used to keep the dependency list unchanged, at the cost of higher write load on the primary database under attack.
- No true sliding-window-log or weighted sliding-window-counter smoothing — this is a plain fixed window per key, so a client can send `limit` requests at the very end of one window and another `limit` at the very start of the next, briefly exceeding the intended rate near window boundaries.
- No per-user configuration or tiered limits (e.g. higher limits for paying customers, admin bypass).
- No global/account-wide circuit breaker across endpoints — each limiter instance is independent, so a client blocked on login can still hit forgot-password freely. There is no cumulative failed-attempt cap either (see the NIST point above); the counters only ever measure rate.
- No metrics or alerting on sustained blocking, which in production is exactly the signal that an attack is underway. The fail-open path makes this worse than it sounds: it swallows the store error silently, so a limiter that has been switched off by an outage is invisible.
- Headers use an obsolete draft's field syntax — covered above, and a deliberate choice rather than a simplification, but one you should not copy without deciding for yourself.
- No `RateLimit-Policy`, so a client is told the binding limit but never which policy it belongs to or what the other applicable policies are. Collapsing several limiters into one triple is lossy by construction; this app collapses safely, but it still collapses.
- No `trust proxy` configuration, so this app cannot be correctly IP-limited behind a load balancer or CDN without a code change.

## Try it

With the dev server running (`npm run dev`) and seed data loaded, exceed the login limit:

```bash
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5000/api/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"demo@shop.test","password":"wrong"}'
done
```

The first five print `401` and the sixth prints `429` — but only if the loop runs inside one fresh window. The bucket is a wall-clock minute (`Math.floor(now / 60000) * 60000`), not a minute measured from your first request, so a loop that straddles a boundary sees the counter reset midway, and *any* earlier login request in the same minute counts against the five — including successful ones, since the limiter runs before the controller and never learns the outcome. To make the run deterministic, wait for the top of a minute first:

```bash
until [ "$(date +%S)" = "02" ]; do sleep 1; done
```

Inspect the headers on any response:

```bash
curl -i -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@shop.test","password":"wrong"}'
```

Look for `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and, once blocked, `Retry-After`. A blocked response looks like this, with `Retry-After` equal to `RateLimit-Reset`:

```
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 5
RateLimit-Remaining: 0
RateLimit-Reset: 21
Retry-After: 21
```

Now watch the binding-limiter rule. In a fresh window, spend three attempts on one email and then send one on another:

```bash
until [ "$(date +%S)" = "02" ]; do sleep 1; done
for i in 1 2 3; do
  curl -s -o /dev/null -X POST http://localhost:5000/api/auth/login \
    -H 'Content-Type: application/json' -d '{"email":"a@shop.test","password":"wrong"}'
done
curl -s -D - -o /dev/null -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"b@shop.test","password":"wrong"}' | grep -i ratelimit
```

The response reports `RateLimit-Remaining: 1`. The email-keyed limiter for `b@shop.test` has 4 of its 5 left and runs second, but it is not allowed to raise the number the IP-keyed limiter already reported. One is the truthful answer: exactly one more request will be allowed from this address, whatever email it carries, and the one after that is refused. Send two more and you will see `401` then `429`, in that order — the header predicted the budget correctly. Before this behaviour existed the same response claimed `4`, and a client pacing itself off it would have sent four more and been rejected on the second.

Finally, watch the fixed-window boundary burst — the weakness this algorithm has by construction. Start just before the top of a minute so the run straddles a window boundary:

```bash
until [ "$(date +%S)" = "58" ]; do sleep 1; done
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code} " -X POST http://localhost:5000/api/auth/login \
    -H 'Content-Type: application/json' -d '{"email":"demo@shop.test","password":"wrong"}'
  sleep 0.4
done; echo
```

A representative run prints `401 401 401 401 401 401 401 401 429 429` — eight requests accepted inside about three seconds against a nominal limit of five per minute, because the counter reset in the middle of the run. Exactly where the boundary lands varies, but more than five will get through every time. A sliding-window counter, a token bucket or GCRA would all have held the line here; a fixed window structurally cannot.

## Further reading

- [draft-ietf-httpapi-ratelimit-headers-11](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-11) — the current IETF draft, and the reason the header section above exists. Read §3 and §4 for the `RateLimit-Policy` / `RateLimit` structured fields that replaced the three-header form, and §5 for how `Retry-After` is expected to interact with them.
- [draft-ietf-httpapi-ratelimit-headers-05](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-05) — the July 2022 revision whose `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` syntax this code actually emits. Worth opening beside `-11` to see how much a draft can move under you, which is the real lesson for anyone shipping against one.
- [RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4) — two paragraphs, and the entire normative basis for 429. It is also where the permission to attach `Retry-After` to a 429 comes from, which RFC 9110 does not grant on its own.
- [RFC 9110 §10.2.3](https://httpwg.org/specs/rfc9110.html#field.retry-after) — the definition of `Retry-After` in current HTTP semantics: `HTTP-date / delay-seconds`, nothing else. Note it is written around 503 and 3xx, so pairing it with 429 is RFC 6585's doing.
- [Cloudflare: How we built rate limiting capable of scaling to millions of domains](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) — the canonical description of the sliding-window-counter approximation, with the weighting formula, the memory argument for choosing it over a sliding log, and a measured error rate (0.003% over 400 million requests) instead of a hand-wave.
- [Stripe: Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters) — the best short piece on the fact that "rate limiting" in production is four different controls (request rate, concurrency, fleet load shedding, worker load shedding) serving different failure modes. Read it if your instinct is that one limiter is enough.
- [Brandur Leach: Rate limiting, cells, and GCRA](https://brandur.org/rate-limiting) — walks from time buckets to leaky bucket to GCRA and explains precisely why removing the background drip makes the algorithm more robust, not just cheaper. The clearest explanation of GCRA outside the ATM specifications it came from.
- [`express-rate-limit` configuration reference](https://express-rate-limit.mintlify.app/reference/configuration) — read the `standardHeaders` section specifically. That one option exposes three incompatible header formats (`draft-6`, `draft-7`, `draft-8`) behind a single boolean's history, which is the clearest practical illustration of why the spec question above matters.
- [Redis: INCR — Pattern: rate limiter](https://redis.io/docs/latest/commands/incr/#pattern-rate-limiter) — the fixed-window counter in its native habitat, including the `INCR`-without-`EXPIRE` race and the Lua fix for it. Useful for seeing what this MongoDB implementation is a stand-in for.
- [MongoDB: TTL indexes](https://www.mongodb.com/docs/manual/core/index-ttl/) — the primary source for the 60-second sweep interval, the single-threaded deletion task, and the explicit statement that expiry is not deletion. Read before relying on a TTL index for anything where the delay matters.
- [NIST SP 800-63B-4 §3.2.2, Rate Limiting (Throttling)](https://pages.nist.gov/800-63-4/sp800-63b.html) — the requirement that turns rate limiting from a performance control into an authentication control: a cumulative cap of 100 consecutive failed attempts per authenticator, which a per-minute limiter does not provide.
- [OWASP Credential Stuffing Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html) — why IP-keyed limits fail against distributed attacks, stated by people who have watched it happen, plus the defences that actually move the needle (MFA, breached-password screening).
- [OWASP API Security Top 10 — API4:2023 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/) — the money-shaped case for limiting. Its first example is an unlimited forgot-password endpoint billed per SMS; this app's `/forgot-password` limiter exists for exactly that reason.
- [RFC 7239 §8.1](https://www.rfc-editor.org/rfc/rfc7239.html#section-8.1) and [Express: behind proxies](https://expressjs.com/en/guide/behind-proxies.html) — why forwarding headers are worthless unless a trusted proxy overwrites them, and the one Express setting that decides whether `req.ip` means anything in your deployment.
- [`mern-tickets/server/src/throttle/README.md`](../../../../mern-tickets/server/src/throttle/README.md) — the token bucket counterpart to this fixed window, and the file that draws the rate-limiting/throttling/quota distinction properly.
- [`../passwordReset/README.md`](../passwordReset/README.md) and [`../blocklist/README.md`](../blocklist/README.md) — the two endpoints these limiters protect, and why each one is keyed the way it is.
