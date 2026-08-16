# Movies domain

## What this is

The core domain of `mern-movies`: actors, movies, users, and the two
signals a user leaves behind after watching something — a rating and a
watch. Everything else in this app (the recommender in
`server/src/recommendations/`, the follow/notify fan-out in
`server/src/notifications/`) is built on top of these five models.

## How it works here

Five Mongoose models live in `server/src/models/`:

- `Actor` (`server/src/models/actor.js`) — just a `name`.
- `Movie` (`server/src/models/movie.js:3-9`) — `title`, `genres` (a
  plain string array, no separate Genre collection), `cast` (an array
  of `ObjectId` refs to `Actor`), `averageRating`, and `releasedAt`.
- `User` (`server/src/models/user.js`) — `name`, a unique `email`, a
  `passwordHash`, and a `role` of `'user'` or `'admin'`.
- `Rating` (`server/src/models/rating.js`) — one row per
  `{ user, movie }` pair, enforced by a unique compound index
  (`server/src/models/rating.js:10`), holding a `value` from 1 to 10.
- `Watch` (`server/src/models/watch.js:3-9`) — one row per
  `{ user, movie }` pair, same unique-index shape, holding only
  `watchedAt`.

Every Mongoose call lives in `server/src/repositories/` (`actors.js`,
`movies.js`, `users.js`, `ratings.js`, `watches.js`). Every rule about
who can do what lives in `server/src/services/`. `create` in
`server/src/services/movies.js:19-31` is the shape every write
follows: check the caller is allowed (`requireAdmin`, defined once in
`server/src/services/authorize.js` and shared by every service that
needs it), validate the input, then delegate to the repository.
Controllers (`server/src/controllers/`) only translate between HTTP
and services — see `server/src/controllers/movies.js`. Routes
(`server/src/routes/`) only wire paths to controller functions and are
mounted in `server/src/app.js:18-23`.

Caller identity is the `x-user-id` header, read once by
`server/src/middleware/currentUser.js` and attached to `req.userId`.
**This is not authentication** — anyone can put any user id in that
header, there is no session, no token, no password check on any
request. It exists purely so the recommender and the notification
fan-out have someone to compute a personalized answer for. See
`mern-tickets` in this same monorepo for what a real authorization
layer looks like.

`POST /api/ratings` and `POST /api/watches` both upsert
(`server/src/repositories/ratings.js:3-9`,
`server/src/repositories/watches.js:3-9`): rating the same movie twice
replaces the stored value rather than creating a second row.

**What actually happens when two upserts race.** This is worth getting
exactly right, because the intuitive answer ("one wins, the other gets
a duplicate-key error") is not what MongoDB documents or what it does.

Without a unique index, a concurrent upsert is genuinely unsafe:
MongoDB's manual walks through the case where every operation finishes
its query phase before any of them inserts, so each one decides to
insert and you end up with several documents that were supposed to be
one. That is why the index on `{ user, movie }` exists, and why the
manual's guidance on `upsert` is "to avoid multiple upserts, ensure
that the filter field(s) are uniquely indexed."

With the unique index in place, the manual says the losing operations
"either update the newly-inserted document or fail due to a unique key
collision," and it lists the conditions under which the first, benign
branch is taken. All of them hold for the repositories here:

- the collection has a unique index that would cause the error — yes,
  `{ user: 1, movie: 1 }`;
- the operation is a single-document update, not `updateMany` — yes,
  `findOneAndUpdate`;
- the filter is an equality predicate or a logical AND of equality
  predicates — yes, `{ user: userId, movie: movieId }`;
- those predicate fields match the unique index key pattern — yes;
- the update does not modify any field in the index key pattern — yes,
  it touches `value`, `createdAt`, `watchedAt`, never `user`/`movie`.

So the loser of the race does not fail; it re-runs as an update against
the row the winner just inserted. Verified rather than assumed: racing
eight concurrent `findOneAndUpdate` upserts on the same
`{ user, movie }` pair, repeated 200 times against MongoDB 7.0, gave
1600 successful operations, zero `11000` errors, and exactly one row
per race.

The gap worth knowing about is therefore narrower and more specific
than "concurrent upserts 500 here." Break any one of those conditions —
add a non-equality clause to the filter, or `$set` a field that is part
of the index key — and the loser really does get a duplicate-key error.
At that point this app has nothing to catch it: `errorHandler`
(`server/src/middleware/error.js:22-28`) has branches for
`ValidationError`, `CastError` and any error carrying a `status`, and
code `11000` matches none of them, so it falls through to a generic
500. MongoDB's own retryable-writes machinery does not help either,
twice over: retryable writes exist only against a replica set or
sharded cluster — on the standalone `mongod` this repo runs there is no
retry at all — and even where they exist the driver retries once, for
transient network errors and replica-set elections, never for
application-level errors like a duplicate key. Compare
`../../../../mern-shop/server/src/rateLimit/README.md`, where the same
situation arises on a filter that genuinely can collide and the
repository catches `11000` and retries once.

**The unique index is not in force the instant the app starts.** These
models declare the constraint with `schema.index({ user: 1, movie: 1 },
{ unique: true })`, and Mongoose is explicit that this is shorthand for
creating a MongoDB unique index rather than a validator — the index is
built asynchronously after the model compiles. Nothing on the startup
path (`server/src/db.js`, `server/src/index.js`, `server/src/seed.js`)
waits for that build to finish. The test suite does:
`server/test/helpers.js:10` calls `syncIndexes()` on every model after
dropping the database, which is exactly why the two "enforces the
unique index at the database level" tests are reliable. Against a
brand-new production database there is a window at first boot where the
index does not exist yet and duplicates can be written. Awaiting
`Model.init()` before accepting traffic is the documented fix, and this
app does not do it.

**The read paths carry secondary indexes of their own**, added after an
audit found every one of them collection-scanning. `Movie` declares
`{ genres: 1 }` — a multikey index over the string array — for
`GET /api/movies?genre=`, and `{ averageRating: 1 }` for the
recommender's `averageRating >= 7` eligibility floor
(`server/src/repositories/movies.js`, `findEligible`). Elsewhere,
`Follow` declares `{ actor: 1 }` for the fan-out's by-actor lookup and
`Notification` declares `{ user: 1, readAt: 1, createdAt: -1 }` for the
notification list — see `../notifications/README.md`. Be precise about
what the `averageRating` index buys: the `$gte` becomes an index range
scan, but `findEligible` also excludes the caller's history with an
`_id $nin`, which still has to be checked against every document the
range matches — that exclusion list is the real scaling wall, named in
`../recommendations/README.md`. The startup caveat above applies to all
of these too: schema-declared indexes are built asynchronously, and
until a build finishes the queries run, just unindexed.

## The core concepts

**A rating is explicit feedback, a watch is implicit feedback.** When
a user rates a movie they are telling you, in one deliberate action,
exactly how they felt about it — a 9 means they liked it, a 3 means
they didn't. A watch tells you only that they pressed play and (as far
as this API knows) got to the end. They might have loved it, hated it,
or fallen asleep. That is why the recommender in
`server/src/recommendations/README.md` treats a rating as a strong
signal and a watch without a rating as a much weaker one — see the
1.2/0.8 rating multipliers versus the 1.1 watch multiplier there.

**Why `averageRating` lives on the movie instead of being computed
from `Rating` documents.** A real product would aggregate `Rating`
into an average continuously (or on a schedule) and write it back onto
the movie — that write-back is exactly the "denormalize the read path"
trade every content platform makes, because computing an average
across potentially millions of ratings on every single read of every
single movie is not something you want in the hot path of a list
endpoint.

This has a name in MongoDB's own schema-design material — the
**computed pattern** — and its stated preconditions are worth checking
against rather than reaching for the trade reflexively. It applies
when reads are significantly more common than writes, when the
computation is expensive enough to matter (large datasets, many
documents examined), and when some staleness is acceptable, since a
value refreshed on a schedule is by definition not exact between
refreshes. Movie ratings satisfy all three comfortably: everybody reads
the average, almost nobody writes a rating, and nobody notices if the
average is a few minutes behind.

The pattern also names the two ways to keep the value fresh — recompute
on every write, or recompute at intervals via an aggregation pipeline —
which is the actual design decision hiding behind "a real system would
recompute it." This toy does neither: it skips the aggregation entirely
and seeds `averageRating` as a fixed field on `Movie`, so the
[recommender](../recommendations/README.md) has a ready-made quality
signal without needing a real rating distribution behind it. In a real system, `POST
/api/ratings` would trigger a recompute; here it does not, and that gap
is intentional and documented rather than silently missing. It is also
the reason the popularity-amplification feedback loop described in
`server/src/recommendations/README.md` cannot close in this codebase.

## Standard practice

- **Layered architecture (routes / controllers / services /
  repositories)** — one why: it means the ranking rules and the
  fan-out rules can be unit-tested with zero Express and zero HTTP, as
  proven by `server/src/recommendations/rank.js` and
  `server/src/notifications/fanout.js`.
- **Repositories are the only files that import a model** — one why:
  swapping Mongoose for another driver, or adding a cache, touches one
  file per collection instead of every file that happens to query it.
- **Unique compound indexes for `{ user, movie }`** — one why: it
  turns "don't create a duplicate rating" from an application-level
  race condition into something the database refuses to let happen,
  even under concurrent requests. Caveat above: nothing awaits the
  index build at startup, so the guarantee has a window where it does
  not yet hold.
- **Upsert instead of check-then-write** — one why: check-then-write
  has a race window between the check and the write; `findOneAndUpdate`
  with `upsert: true` is a single atomic operation. Note that the
  atomicity of the single operation is not by itself enough — it is the
  unique index on the filter fields that stops concurrent upserts from
  each deciding to insert, which is why the manual ties the two
  together rather than treating `upsert` as sufficient on its own.
- **Typed error classes with a `status` field
  (`server/src/middleware/error.js`)** — one why: every controller can
  `throw` and let one error-handling middleware translate it to the
  right HTTP status, instead of each controller hand-rolling
  `res.status(...)` on every failure path.

## What this toy skips

- No password login flow, despite `User` having a `passwordHash` and
  the `bcrypt` dependency being installed (used only by the seed
  script). Caller identity is the unauthenticated `x-user-id` header.
  See `../../../../mern-shop/server/src/passwordReset/README.md` for a
  credential flow built properly, and
  `../../../../mern-tickets/server/src/policy/README.md` for the
  authorization layer this app has no equivalent of.
- No recomputation of `averageRating` when new ratings arrive — it is
  seeded once and never updated.
- No handler for duplicate-key errors (code `11000`) anywhere in
  `server/src/middleware/error.js`, so if one ever escaped a repository
  it would be reported as a 500 rather than a 409.
- No wait for index builds at startup, so the unique-index guarantees
  above are not in force for a window on a fresh database.
- No pagination, sorting options, or search on `GET /api/movies`
  beyond the single `genre` filter.
- No soft-delete or audit trail — `deleteAll` in the repositories is
  a hard delete used only by the seed script.

## Try it

```
npm run seed
npm start

curl http://localhost:5003/api/movies
curl "http://localhost:5003/api/movies?genre=scifi"
curl http://localhost:5003/api/actors

curl -X POST http://localhost:5003/api/actors \
  -H 'Content-Type: application/json' \
  -H "x-user-id: <admin user id from the seed output>" \
  -d '{"name":"Idris Elba"}'

curl -X POST http://localhost:5003/api/movies \
  -H 'Content-Type: application/json' \
  -H "x-user-id: <admin user id from the seed output>" \
  -d '{"title":"New Release","genres":["action"],"cast":["<actor id from GET /api/actors>"],"averageRating":8,"releasedAt":"2024-01-01"}'

curl -X POST http://localhost:5003/api/ratings \
  -H 'Content-Type: application/json' \
  -H "x-user-id: <user id from the seed output>" \
  -d '{"movieId":"<movie id from GET /api/movies>","value":8}'

curl -X POST http://localhost:5003/api/watches \
  -H 'Content-Type: application/json' \
  -H "x-user-id: <user id from the seed output>" \
  -d '{"movieId":"<movie id from GET /api/movies>"}'
```

Rating the same movie a second time with a different `value` returns
201 again, with the stored value replaced rather than a second row
created — that is the upsert at
`server/src/repositories/ratings.js:3-9`. Note the status is
unconventional: 201 means "created", and an upsert that replaced an
existing row is semantically an update, where 200 would be the usual
answer. Creating a movie as a non-admin user returns 401 — also
looser than the convention, since 401 means unauthenticated and 403 is
the status for a caller who is identified but not permitted; the code
keeps 401 because other guides reference this behaviour as is.

## Further reading

Every link below was fetched and checked against what this README
claims. The MongoDB manual pages are the source for the concurrency
behaviour described above; the claims were also re-verified against a
running MongoDB 7.0 rather than taken on trust.

**What MongoDB actually guarantees**

- [db.collection.findAndModify — Upsert with Unique Index](https://www.mongodb.com/docs/manual/reference/method/db.collection.findAndModify/)
  — the page that settles the concurrent-upsert question. Read the
  "Upsert with Unique Index" section closely: it gives both the failure
  case without an index and the five conditions under which a losing
  concurrent upsert updates the winner's document instead of erroring.
  This is the reference behind the correction in "how it works here."
- [Unique Indexes](https://www.mongodb.com/docs/manual/core/index-unique/)
  — what the constraint does and does not cover, including compound
  keys, missing fields, and the sharded-cluster restrictions.
- [db.collection.updateOne — upsert](https://www.mongodb.com/docs/manual/reference/method/db.collection.updateOne/)
  — short, and contains the operative instruction: to avoid multiple
  upserts, ensure the filter fields are uniquely indexed.
- [Retryable Writes](https://www.mongodb.com/docs/manual/core/retryable-writes/)
  — which operations drivers retry, how many times (once, by default),
  the topology requirement (replica set or sharded cluster, never a
  standalone), and the boundary that matters here: transient network
  errors and elections, never application-level errors like a
  duplicate key.
- [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)
  — required reading before assuming you can wrap two collection writes
  atomically: replica set or sharded cluster only, plus MongoDB's own
  argument that good schema design should remove most of the need.

**Schema design**

- [Computed Schema Pattern](https://www.mongodb.com/docs/manual/data-modeling/design-patterns/computed-values/computed-schema-pattern/)
  — the named pattern behind storing `averageRating` on the movie, with
  its three preconditions (read-heavy, expensive computation,
  tolerable staleness) and the two refresh strategies. Use it to decide
  whether a denormalized aggregate is justified rather than assuming.
- [Mongoose FAQ](https://mongoosejs.com/docs/faq.html)
  — the entry on `unique` is the one to read: it is not a validator,
  only shorthand for an index, and duplicates can be saved before the
  index build completes. This is the source for the startup-window gap
  described above and the reason the test helper calls `syncIndexes()`.

**Signals**

- [Collaborative Filtering for Implicit Feedback Datasets (Hu, Koren, Volinsky, ICDM 2008)](http://yifanhu.net/PUB/cf.pdf)
  — the rigorous version of the explicit-versus-implicit distinction
  this domain is built on. The key correction to the intuitive framing:
  implicit feedback carries no negative signal, and its magnitude is
  confidence rather than preference.

**Elsewhere in this monorepo**

- `../recommendations/README.md` — what the `Rating` and `Watch`
  signals are consumed for, and why the missing `averageRating`
  recompute matters more than it looks.
- `../notifications/README.md` — the fan-out triggered by
  `services/movies.js:19-31`, and the delivery semantics that follow
  from doing it outside a transaction.
- `../../../../mern-tickets/server/src/policy/README.md` — a real
  authorization layer, against which the `x-user-id` header here is
  best read as a placeholder.
- `../../../../mern-tickets/server/src/tickets/README.md` — an
  append-only audit log over a domain with a real lifecycle, which is
  the thing this domain's hard deletes and missing audit trail skip.
- `../../../../mern-shop/server/src/rateLimit/README.md` — the
  duplicate-key-on-upsert case with the retry actually implemented.
- `../../../../mern-shop/server/src/passwordReset/README.md` — the
  credential handling this app has a `passwordHash` column for and
  nothing else.
