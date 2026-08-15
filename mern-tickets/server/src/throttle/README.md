# Throttling

## What this is

A token bucket per user per action, persisted in MongoDB, that limits how fast one caller can create tickets or post comments while still allowing short bursts. It answers "how fast is this one actor allowed to go," not "how much total load can the service take."

## How it works here

`consume(userId, action, now)` (`src/throttle/tokenBucket.js:29`) loads (or creates) a bucket document keyed by `${userId}:${action}` (e.g. `64f.../ticket:create`), computes how many tokens the elapsed time since `updatedAt` would refill via `computeRefill` (`src/throttle/tokenBucket.js:9`), and — if at least one token is available — writes back `tokens: refilled - 1` and bumps `updatedAt` to `now`. `computeRefill` is a pure function: `min(burst, tokens + elapsedMinutes * refillPerMinute)`, capped at the bucket's burst size so idle time cannot accumulate an unbounded credit.

The write in `consume` is a compare-and-swap: `buckets.updateIfUnchanged` (`src/repositories/tokenBuckets.js:11`) matches on `_id`, `updatedAt`, and `tokens` together as they were just read, so if a concurrent request already modified the same bucket, the update matches nothing, returns `null`, and `consume` retries the whole read-compute-write cycle (`src/throttle/tokenBucket.js:32-43`) from the fresh state — this is what "atomic" means here: no two concurrent requests can both believe they spent the same token. Under heavy enough contention for the same bucket, that retry loop can still run out of attempts; when it does, `consume` reports `{ allowed: false, tokens: 0, retryAfter: 1 }` rather than throwing, so a caller who loses every race still gets a normal 429 with a short `Retry-After` instead of a 500 — contention is treated as "try again in a second," not a server error.

`throttle(userId, action)` (`src/throttle/tokenBucket.js:47`) is the enforcement wrapper services call: it consumes a token and, if none were available, throws `TooManyRequestsError('too many requests', retryAfter)`. The error middleware (`src/middleware/error.js`) turns that into a 429 with a `Retry-After` header set to `retryAfter` seconds — computed by `retryAfterSeconds` (`src/throttle/tokenBucket.js:14`) as the time until the deficit between the current (fractional) token count and 1 whole token would be refilled at this bucket's rate, rounded up so the client is never told to retry too early.

`RATES` (`src/throttle/tokenBucket.js:4`) configures two buckets: ticket creation (burst 5, refill 1/minute) and comment creation (burst 20, refill 5/minute). `create` and `addComment` (`src/services/tickets.js:37`, `src/services/tickets.js:105`) each call `throttle` before doing anything else expensive (moderation hooks, database writes), so a caller who is over their limit is rejected as cheaply as possible.

## The core concepts

- **Rate limiting** protects the service as a whole from aggregate load — typically enforced per IP address at a reverse proxy or gateway, in front of authentication, because its job is to stop the service falling over before it even knows who is asking.
- **Throttling** (what this module does) shapes one authenticated actor's sustained rate over time while still allowing a burst — the actor is known, the limit is per-identity, and a short spike is expected and tolerated.
- **Quotas** are a billing/entitlement concept over a long period (1,000 tickets per month), not a request-rate concept — a quota can be exhausted and still leave a caller able to make requests slowly; a throttle limits speed, not total count over unbounded time.
- **Backpressure** is what a queue or worker pool does when it cannot keep up with accepted work — signaling "slow down" or shedding load internally, downstream of acceptance, rather than rejecting a request before accepting it at all.
- **Token bucket** vs. **leaky bucket**: a token bucket accumulates capacity while idle (up to `burst`) and spends it in a burst, which matches "let someone catch up after being quiet, but not sustain it forever." A leaky bucket instead smooths output to a constant rate regardless of arrival pattern, which suits shaping outbound traffic rather than describing what an actor is allowed to do.
- **Lazy refill**: tokens are computed on demand from elapsed wall-clock time at the moment of an actual request, not incremented by a periodic job. There is nothing to schedule, nothing idle actors cost the system, and the same formula is correct whether the last request was one second or one week ago.

## Standard practice

- Compute refill from elapsed time on read, not a cron tick — a cron-based refiller has to run for every bucket whether or not anyone is asking, and its granularity becomes the limit's real precision.
- Cap refilled tokens at `burst` — otherwise a caller idle for a long time accumulates an unbounded credit and can burst far harder than the limit intends.
- Make the consume-and-decrement step atomic against concurrent requests for the same key — a naive read-then-write from application code is a race that lets two simultaneous requests both spend the last token.
- Key the bucket by both actor and action — a single global bucket per user would let heavy comment traffic starve that same user's ability to create a ticket, which is not what either limit is meant to express.
- Return `Retry-After` computed from the actual deficit, not a fixed constant — a fixed value is either too conservative (wasted client wait) or wrong (client retries too early and gets rejected again).

## What this toy skips

- A cross-reference to `mern-shop/server/src/rateLimit/README.md`: that companion doc covers a fixed-window rate limiter applied to login and password-reset, keyed by IP or by credential rather than by an authenticated actor's own identity — the same distinction drawn inline above (rate limiting protects the service at the edge; throttling shapes one known actor's sustained rate), worked out there against a different mechanism (fixed window + TTL index) instead of a token bucket.
- Per-IP rate limiting at the edge — this module only throttles authenticated actors; an unauthenticated flood of requests before `identify` runs is not addressed here at all.
- A sliding-window or leaky-bucket alternative — token bucket was chosen because "allow a burst, then settle to a sustained rate" is the desired shape for both tickets and comments.
- Backoff coordination between client and server beyond a single `Retry-After` value — there is no exponential backoff policy communicated, just the time until the next token.
- Bucket cleanup — a `TokenBucket` document is created once per user/action pair and never deleted, even for users who stop being active.

## Try it

```
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:5001/api/tickets \
    -H 'Content-Type: application/json' -H 'x-user-id: <rae id>' \
    -d "{\"title\":\"t\",\"body\":\"body $i\",\"priority\":\"normal\"}"
done
```

The first five print `201`; the sixth prints `429`, and `curl -i` on that sixth request shows a `Retry-After: 60` header (one token refills per minute for ticket creation).
