# mern-movies

A movie API carrying two teaching features: a content-based
"recommended for you" ranker with explicit, testable rules, and a
follow/notify fan-out where following an actor gets you notified when
that actor appears in a newly added movie. API only, no client, layered
the same way as `mern-shop/server`: `routes/` wire HTTP, `controllers/`
adapt it, `services/` hold the rules, `repositories/` own every
Mongoose call.

## Feature READMEs

- [`server/src/movies/README.md`](server/src/movies/README.md) — the
  domain: actors, movies, users, ratings, watches, and why ratings and
  watches are kept as separate signals.
- [`server/src/recommendations/README.md`](server/src/recommendations/README.md)
  — the ranking algorithm: content-based filtering, the cold-start
  problem, explicit vs. implicit signals, hard filters vs. soft
  penalties, popularity bias, diversity, explainability, determinism,
  and offline vs. online evaluation.
- [`server/src/notifications/README.md`](server/src/notifications/README.md)
  — the follow/notify fan-out: fan-out-on-write vs. fan-out-on-read,
  the celebrity problem, idempotency via unique indexes, delivery
  guarantees, and the transactional outbox pattern.

## Running it

Requires MongoDB reachable at `mongodb://127.0.0.1:27017` (the repo's
existing Docker Mongo works — no separate database needed for this
app beyond its own database name).

```
cd server
npm install
npm run seed    # ~25 movies across 8 genres, 12 actors, 3 users (one admin)
npm start       # listens on PORT (default 5001)
```

Run the tests (uses a separate `mern-movies-test` database, dropped
and its indexes resynced before every test):

```
cd server
npm test
```

Caller identity for every endpoint is the `x-user-id` header — **this
is not authentication**. Any request can claim to be any user id;
there is no session, token, or password check anywhere in this app. It
exists only so the recommender and the notification fan-out have a
caller to compute a personalized answer for. See `mern-tickets` in this
same monorepo for what a real authorization layer looks like.

There is no users endpoint, so user ids come from `npm run seed`'s own
output — it prints the id and role of every user it creates:

```
seeded 12 actors, 25 movies, 3 users
  admin: admin@movies.test -> 6a8032dc9b90fd244426dae9
  user: fiona@movies.test -> 6a8032dc9b90fd244426daea
  user: sam@movies.test -> 6a8032dc9b90fd244426daeb
```

Actor and movie ids come from the list endpoints, unauthenticated:

```
curl http://localhost:5001/api/actors
curl http://localhost:5001/api/movies

curl http://localhost:5001/api/recommendations -H "x-user-id: <user id from the seed output>"

curl -X POST http://localhost:5001/api/actors/<actor id>/follow \
  -H "x-user-id: <user id from the seed output>"
```
