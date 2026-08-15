# Follow and notify

## What this is

Following an actor means you get notified when that actor shows up in
a newly added movie. `POST /api/actors/:id/follow` and
`DELETE /api/actors/:id/follow` manage the subscription; when an admin
creates a movie, every follower of every cast member gets a
`Notification`; `GET /api/notifications` and
`POST /api/notifications/:id/read` read and acknowledge them.

## How it works here

`Follow` (`server/src/models/follow.js`) is `{ user, actor, createdAt }`
with a unique index on `{ user, actor }`. `Notification`
(`server/src/models/notification.js`) is
`{ user, type: 'actor_in_new_movie', actor, movie, readAt, createdAt }`
with a unique index on `{ user, movie, actor }` — one row per
(follower, movie, followed-actor) triple, which is exactly the
granularity the plan asks for: a user following two cast members of
the same movie gets two notifications, one per actor, not one per
movie.

The fan-out itself is one function,
`fanoutNewMovie(movie)` in `server/src/notifications/fanout.js:4-16`:
it collects every distinct actor id in the movie's cast, does **one**
query for every `Follow` row referencing any of them
(`fanout.js:7`, via `followsRepo.findByActors`), and if there are any,
builds one document per (follower, actor) pair and writes them with a
**single** `insertMany(docs, { ordered: false })`
(`server/src/repositories/notifications.js:10`). There is no
per-follower round trip anywhere in this path.

`server/src/services/movies.js:19-31` (`create`) is where fan-out gets
triggered, and the order matters: `moviesRepo.create` runs first
(`movies.js:24`) and only then does `fanoutNewMovie` run
(`movies.js:26`), wrapped in a `try`/`catch` that logs and swallows any
error (`movies.js:25-29`). The movie is fully persisted before the
fan-out is even attempted, and nothing the fan-out does can turn a
successful movie creation into a failed HTTP response.

Follow/unfollow are ordinary services
(`server/src/services/follows.js`): `follow` upserts
(`server/src/repositories/follows.js:3-9`) so following twice is a
no-op rather than a duplicate-key error, and `unfollow` is a plain
delete. Notifications are read via
`server/src/services/notifications.js`, backed by
`server/src/repositories/notifications.js:17-19`, which sorts unread
first by ordering `readAt` ascending — a `null` `readAt` sorts before
any real date in MongoDB's BSON type ordering, then `createdAt`
descending as the tiebreak.

## The core concepts

**Fan-out-on-write vs. fan-out-on-read.** This system fans out on
write: the moment a qualifying movie is created, a `Notification` row
is materialized for every follower who cares. The alternative,
fan-out-on-read, would store nothing at write time and instead, when a
user opens their notifications, compute on the fly which movies were
added recently that feature an actor they follow. Fan-out-on-write
trades storage (one row per follower per event, potentially a lot of
rows) for read speed (`GET /api/notifications` is a single indexed
query, `server/src/repositories/notifications.js:17-19`, no
computation). Fan-out-on-read trades that storage back for slower,
heavier reads, because every read has to reconstruct what "new for
this user" means from scratch. Notification and feed systems
overwhelmingly choose fan-out-on-write because reads (a user checking
their notifications) vastly outnumber writes (a new movie being
added), so paying the cost once at write time and reading cheaply
forever is the better trade.

**The celebrity problem.** Fan-out-on-write breaks down when a single
write fans out to an enormous number of rows — an actor with a million
followers turns one movie creation into a million notification writes.
This implementation is bulk (one query, one insert,
`fanout.js:7,15`) rather than one-row-at-a-time, which is the first
and cheapest mitigation, but a genuinely huge fan-out (millions of
rows from one event) usually needs more: batching the insert into
chunks so a single operation doesn't hold a write lock or a connection
too long, doing the fan-out asynchronously via a queue instead of
inline with the HTTP request, or — the actual "celebrity" fix used by
large-scale feed systems — a hybrid: cap fan-out-on-write to followers
below some threshold, and serve the celebrity's own followers via
fan-out-on-read instead, so one wildly popular actor can't take down
the write path for everyone.

**Idempotency keys and unique indexes as dedupe.** The unique index on
`{ user, movie, actor }` is what makes "run the fan-out twice" safe:
the second run tries to insert the exact same triples, MongoDB refuses
them as duplicates, and the repository's `insertMany` catches that
specific failure and returns whatever *did* insert rather than
throwing (`repositories/notifications.js:11-13`). This is the same
idea as an idempotency key on a payment API — a natural composite key
derived from "what this operation is about" turns "did this already
happen" into a question the database itself answers, rather than
something the caller has to track separately.

**At-least-once vs. at-most-once vs. exactly-once.** Because the movie
write and the notification write are two separate operations with no
shared transaction, this system can only promise one or the other, not
both: if it retried a failed fan-out, a follower could end up notified
twice for the same movie (except the unique index prevents that
specific failure mode); if it does not retry, as implemented here, a
follower can end up notified zero times if the write fails. This
implementation chooses **best-effort, at-most-once**: the `try`/`catch`
in `movies.js:25-29` means a fan-out failure is logged and silently
dropped, never retried. "Exactly-once" delivery is, in the general
case, a fiction — you can get exactly-once *effects* (via idempotency
keys, as above) but not exactly-once *delivery attempts*, because there
is always a failure window between "the work was done" and "the caller
was told it was done" where a retry is indistinguishable from a
duplicate.

**The transactional outbox — the real fix.** The honest problem with
this implementation is that "create the movie" and "notify the
followers" are two separate writes to two separate collections with no
atomicity between them: if the process crashes between them, the movie
exists and the notifications silently never happen, with nothing left
behind to say they were supposed to. The transactional outbox pattern
fixes this by writing the *intent* to fan out — "movie X was created,
notify its followers" — into an outbox table in the **same** database
transaction as the movie write itself, so either both happen or
neither does. A separate worker then reads the outbox and performs the
actual fan-out, retrying on failure, and only marks the outbox entry
processed once fan-out genuinely succeeds — turning "notification
writes are best-effort" into "notification writes are guaranteed
eventually, with retries, and observable while pending." This
implementation has none of that: no outbox collection, no background
worker, no retry. It swallows the failure and moves on.

**Backfill and replay.** Because `fanoutNewMovie` is idempotent by
construction, it is also naturally replayable: if a bug in this
implementation silently dropped fan-out for a batch of movies added
last week, the fix is to re-run `fanoutNewMovie` for each of those
movies — the unique index guarantees already-delivered notifications
are skipped and only the missing ones are created. A system with a
transactional outbox gets this almost for free (replay the outbox); a
system without one, like this toy, needs an operator to manually
identify which movies need re-processing.

**Notification fatigue, batching and digests.** This implementation
sends one row per (follower, actor, movie) unconditionally — a user
following ten actors who all happen to appear in the same ensemble
movie gets ten separate rows in one shot. A real notification system
usually caps or batches this: collapsing multiple triggers into one
digest ("5 actors you follow are in this movie") instead of one
notification per trigger, and rate-limiting or batching over time so
an active user doesn't get flooded. None of that batching exists here.

**Read state and per-device sync.** `readAt` is a single timestamp per
notification row, which works for one client but does not model "read
on my phone, should also show as read when I open my laptop" beyond
the trivial case of both clients reading the same row from the same
database — there is no separate per-device read cursor or
last-synced-at concept here, which a genuinely multi-device product
usually needs.

**Preferences and unsubscribe as a first-class requirement.**
Unfollowing an actor (`DELETE /api/actors/:id/follow`) is the only
preference control in this system. `unfollow` is a plain delete
(`services/follows.js`), so it stops *future* fan-out but, by design,
never touches notifications already created — a test in
`server/test/notifications.test.js` proves existing notifications
survive an unfollow. A real system usually offers finer-grained
preferences than a binary follow/unfollow (mute this actor's
notifications without unfollowing, choose digest frequency, opt out of
this notification type entirely), none of which exist here.

## Standard practice

- **Bulk fan-out: one query, one insert** — one why: a per-follower
  round trip turns a single movie creation into hundreds or thousands
  of database calls, which is both slow and is exactly the celebrity
  problem waiting to happen.
- **`ordered: false` on the bulk insert** — one why: with `ordered:
  true` (the default), the first duplicate-key error in the batch
  would abort every row after it; `ordered: false` lets MongoDB attempt
  every row independently so one bad row never blocks the good ones.
- **A unique compound index doing the dedupe, not application logic**
  — one why: a "check if it exists, then insert" pattern racing against
  a concurrent identical fan-out has a window where both checks pass
  and both inserts happen; the database refusing the duplicate at the
  index level has no such window.
- **Fan-out wrapped in `try`/`catch` around the movie-creation
  response** — one why: a secondary side effect (notifying people)
  should never be able to fail the primary operation (creating the
  movie) that the caller is actually waiting on.
- **Fan-out after the movie is persisted, never before** — one why:
  notifying someone about a movie that then fails to save would be
  notifying them about something that doesn't exist.

## What this toy skips

- No transactional outbox — described above as the real fix, not
  implemented. A crash between the movie write and the fan-out call
  silently drops notifications with no record that they were owed.
- No retry queue for failed fan-outs — a failure is logged
  (`movies.js:28`) and never attempted again automatically.
- No celebrity-scale batching or async processing — fan-out runs
  inline with the HTTP request, on however many followers exist.
- No digesting or rate-limiting — every trigger produces its own row.
- No per-device read-sync, no notification preferences beyond
  follow/unfollow, no email or push delivery — this API only ever
  writes rows a client is expected to poll via `GET /api/notifications`.

## Try it

```
npm run seed
npm start

curl -X POST http://localhost:5001/api/actors/<actor id>/follow \
  -H "x-user-id: <user id>"

curl -X POST http://localhost:5001/api/movies \
  -H 'Content-Type: application/json' \
  -H "x-user-id: <admin user id>" \
  -d '{"title":"New Release","genres":["action"],"cast":["<actor id>"],"averageRating":8,"releasedAt":"2024-01-01"}'

curl http://localhost:5001/api/notifications -H "x-user-id: <user id>"

curl -X POST http://localhost:5001/api/notifications/<notification id>/read \
  -H "x-user-id: <user id>"
```
