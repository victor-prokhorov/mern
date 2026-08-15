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
replaces the stored value rather than creating a second row. The
unique index is what makes a race between two concurrent upserts safe
in the sense that matters: it makes a duplicate row impossible, not
that both requests are guaranteed to succeed. If two upserts for the
same `{ user, movie }` race each other, MongoDB lets exactly one of
them through and the other fails with a duplicate-key error (code
`11000`) rather than creating a second row. This app does not retry
that loser — it surfaces as a 500 — which is a gap worth knowing about
before relying on this pattern under real concurrent write load.

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
endpoint. This toy skips the aggregation pipeline and simply seeds
`averageRating` as a fixed field on `Movie`, so the recommender in
Task 2 has a ready-made quality signal without needing a real rating
distribution behind it. In a real system, `POST /api/ratings` would
also trigger (synchronously or via a background job) a recompute of
the movie's `averageRating`; here it does not, and that gap is
intentional and documented rather than silently missing.

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
  even under concurrent requests.
- **Upsert instead of check-then-write** — one why: check-then-write
  has a race window between the check and the write; `findOneAndUpdate`
  with `upsert: true` is a single atomic operation.
- **Typed error classes with a `status` field
  (`server/src/middleware/error.js`)** — one why: every controller can
  `throw` and let one error-handling middleware translate it to the
  right HTTP status, instead of each controller hand-rolling
  `res.status(...)` on every failure path.

## What this toy skips

- No password login flow, despite `User` having a `passwordHash` and
  the `bcrypt` dependency being installed (used only by the seed
  script). Caller identity is the unauthenticated `x-user-id` header.
- No recomputation of `averageRating` when new ratings arrive — it is
  seeded once and never updated.
- No pagination, sorting options, or search on `GET /api/movies`
  beyond the single `genre` filter.
- No soft-delete or audit trail — `deleteAll` in the repositories is
  a hard delete used only by the seed script.

## Try it

```
npm run seed
npm start

curl http://localhost:5001/api/movies
curl "http://localhost:5001/api/movies?genre=scifi"
curl http://localhost:5001/api/actors

curl -X POST http://localhost:5001/api/actors \
  -H 'Content-Type: application/json' \
  -H "x-user-id: <admin user id from the seed output>" \
  -d '{"name":"Idris Elba"}'

curl -X POST http://localhost:5001/api/movies \
  -H 'Content-Type: application/json' \
  -H "x-user-id: <admin user id from the seed output>" \
  -d '{"title":"New Release","genres":["action"],"cast":["<actor id from GET /api/actors>"],"averageRating":8,"releasedAt":"2024-01-01"}'

curl -X POST http://localhost:5001/api/ratings \
  -H 'Content-Type: application/json' \
  -H "x-user-id: <user id from the seed output>" \
  -d '{"movieId":"<movie id from GET /api/movies>","value":8}'

curl -X POST http://localhost:5001/api/watches \
  -H 'Content-Type: application/json' \
  -H "x-user-id: <user id from the seed output>" \
  -d '{"movieId":"<movie id from GET /api/movies>"}'
```
