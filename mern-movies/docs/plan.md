# mern-movies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A movie API carrying two teaching features: a content-based "recommended for you" ranker with explicit, testable rules, and a follow/notify fan-out where following an actor gets you notified when that actor appears in a newly added movie.

**Architecture:** Same layering as mern-shop — `routes/` wire, `controllers/` adapt HTTP, `services/` hold rules, `repositories/` own every Mongoose call. API only, no client.

**Tech Stack:** Node (ESM), Express, Mongoose, bcrypt, mocha, chai, chai-http.

## Global Constraints

- Dependencies exactly as mern-shop: bcrypt, cors, dotenv, express, express-async-errors, mongodb, mongoose, chai, chai-http, mocha, mocha-junit-reporter, mocha-multi-reporters, cross-env. No recommendation library, no job queue.
- No comments in source or tests. Explanation lives in the READMEs.
- No blank lines inside function bodies, except test bodies (setup / blank / run / blank / assert).
- ESM, `.js` extensions on relative imports.
- Test database `mern-movies-test`, dropped before each test with indexes rebuilt after (copy the `syncIndexes` helper from `mern-shop/server/test/helpers.js`).
- TDD: failing test first with real red output in the commit body, then the fix.
- Branches: `feat/movies-core`, `feat/movies-recommendations`, `feat/movies-notifications`.
- Caller identity is the `x-user-id` header. That is not authentication; say so in the README and point at mern-tickets for the authorization treatment.

## README requirements (every feature)

One page: **What this is** / **How it works here** (with real file:line references) / **The core concepts** / **Standard practice** (checklist, one-line why each) / **What this toy skips** / **Try it** (curl). Plain prose, no emoji.

---

### Task 1: Core domain (`feat/movies-core`)

Scaffold `mern-movies/server` like `mern-shop/server` (same scripts, `.mocharc.json`, app/index split, typed error classes).

**Models**
- `Actor { name }`
- `Movie { title, genres: [String], cast: [ObjectId ref Actor], averageRating: Number, releasedAt }`
- `User { name, email unique, passwordHash, role: 'user' | 'admin' }`
- `Rating { user, movie, value: 1..10, createdAt }` with a unique index on `{ user, movie }`
- `Watch { user, movie, watchedAt }` — a watch **without** a rating, unique on `{ user, movie }`

**Endpoints:** `GET /api/movies` (filter by genre), `GET /api/movies/:id`, `POST /api/movies` (admin only, accepts `cast` as actor ids), `POST /api/ratings` `{ movieId, value }` (upsert), `POST /api/watches` `{ movieId }`, `GET /api/actors`, `POST /api/actors` (admin).

**Seed:** ~25 movies across at least six genres with a spread of `averageRating` from 4 to 9, ~12 actors with overlapping casts, three users. The seed must be rich enough that the recommender in Task 2 has something to choose between; the recommendation tests build their own fixtures rather than relying on it.

**Tests:** movie CRUD-ish paths; rating upsert replaces rather than duplicates; the unique indexes hold; admin-only creation rejected for a normal user.

**README** — `server/src/movies/README.md`, short: the domain, why ratings and watches are separate signals (an unrated watch is weak evidence, a rating is strong), and why `averageRating` is denormalized onto the movie.

---

### Task 2: Recommendations (`feat/movies-recommendations`)

**Files:** `server/src/recommendations/rank.js` (pure, no database), `server/src/recommendations/service.js`, `server/src/recommendations/README.md`, controller, route. Test: `server/test/recommendations.test.js`.

`GET /api/recommendations` returns the caller's "recommended for you" list.

**The rules, exactly.** Implement them as written; the README documents each interpretation:

1. **Eligibility.** Candidates are movies with `averageRating >= 7` that the user has neither rated nor watched. The quality floor is what makes the returned set average at least 7 — a test asserts the mean of returned `averageRating` values is `>= 7`.
2. **Genre affinity from ratings above 5.** Every genre of a movie the user rated `> 5` is a **liked** genre. A candidate sharing at least one liked genre is multiplied by **1.2**.
3. **Ratings of 5 or below favour other genres.** Every genre of a movie rated `<= 5` is a **disliked** genre. A candidate sharing at least one disliked genre is multiplied by **0.8**, so unrelated genres float up rather than being hard-filtered — a test proves a disliked-genre movie can still appear when nothing else is eligible.
4. **Watched but unrated boosts that genre.** Genres of watched-unrated movies are multiplied by **1.1**. Weaker than a rating, because the signal is weaker.
5. Multipliers compose: liked and watched gives `1.2 * 1.1`. A genre that is both liked and disliked (two movies, opposite ratings) applies both `1.2 * 0.8` — the README explains why "conflicting evidence lands near neutral" is the desirable behaviour.
6. **Base score** is the movie's `averageRating`. Final score is base times the composed multiplier.
7. **Return exactly 10** when at least 10 candidates are eligible; fewer only when the pool is smaller, and a test covers that case.
8. **Deterministic.** Sort by score descending, ties broken by `_id` ascending. The same inputs must always give the same list, and a test asserts it by calling twice.
9. Each returned item carries `{ movie, score, reasons: [...] }` where reasons name the multipliers applied (`LIKED_GENRE:thriller`, `DISLIKED_GENRE:comedy`, `WATCHED_GENRE:drama`). A recommendation nobody can explain cannot be debugged.

`rank.js` must be a pure function of `(candidates, signals)` — no database, no Express — so the whole ranker is unit-testable without HTTP. The service is the only part that loads data.

**Tests:** the 1.2 boost changes ordering; the 0.8 penalty demotes without excluding; the 1.1 watch boost applies; composition of multipliers; exactly 10 returned; mean rating of the result `>= 10`... **`>= 7`**; already-rated and already-watched movies never appear; a user with no history gets the top-rated eligible movies; determinism across two calls; reasons present and accurate.

**README** — `server/src/recommendations/README.md`. Concepts: content-based filtering vs collaborative filtering vs hybrids; the cold-start problem (new user, new item) and what this implementation does about it; explicit signals (ratings) vs implicit ones (watches, dwell time) and why implicit signals are noisy but plentiful; eligibility filters vs scoring — hard filters vs soft penalties and when each is right; popularity bias and the feedback loop where recommending popular items makes them more popular; diversity and serendipity, and why a pure relevance sort is a bad product; explainability; determinism and why it matters for testing and for user trust; offline evaluation (precision@k, recall@k, NDCG) versus online A/B testing; where this would move to a vector store or a learned model.

---

### Task 3: Follow and notify (`feat/movies-notifications`)

**Files:** `server/src/notifications/fanout.js`, `server/src/notifications/README.md`, models, repositories, controller, routes. Test: `server/test/notifications.test.js`.

**Models**
- `Follow { user, actor, createdAt }`, unique on `{ user, actor }`
- `Notification { user, type: 'actor_in_new_movie', actor, movie, readAt, createdAt }`, unique on `{ user, movie, actor }`

**Endpoints:** `POST /api/actors/:id/follow`, `DELETE /api/actors/:id/follow`, `GET /api/notifications` (unread first), `POST /api/notifications/:id/read`.

**Requirements**
- When an admin creates a movie, every follower of every cast member gets a notification. Fan-out happens **after** the movie is persisted, never before.
- **Dedupe by construction.** A user following two actors who are both in the same movie gets **one notification per actor**, and the unique index makes a repeated fan-out a no-op rather than a duplicate — the fan-out must tolerate being run twice. A test runs it twice and asserts the count is unchanged.
- Fan-out must not fail the movie creation: the movie is created and 201 returned even if notification writes fail. The README explains this as the at-most-once/at-least-once tradeoff and describes the **transactional outbox** pattern as the real fix.
- Fan-out is bulk: one query for the followers of all cast members, one bulk insert with `ordered: false` so duplicate-key errors on individual rows do not abort the batch. No per-follower round trip — the README explains the celebrity problem (an actor with a million followers) and fan-out-on-write vs fan-out-on-read.
- Adding a movie whose cast nobody follows writes nothing. Unfollowing before a movie is added means no notification; unfollowing afterwards leaves existing notifications alone.

**Tests:** follower of a cast member is notified; non-follower is not; a user following two cast members of the same movie gets exactly two notifications, one per actor; re-running fan-out creates nothing new; a failing notification write still returns 201 for the movie; unread ordering; marking read.

**README** — `server/src/notifications/README.md`. Concepts: fan-out-on-write vs fan-out-on-read and the storage/latency tradeoff; the celebrity problem and hybrid approaches; idempotency keys and unique indexes as dedupe; at-least-once vs at-most-once vs exactly-once (and why exactly-once is a delivery fiction); the transactional outbox and why a write plus a side effect is not atomic without one; backfill and replay; notification fatigue, batching and digests; read state and per-device sync; preferences and unsubscribe as a first-class requirement.

---

## Notes for the executor

- Build Task 1 first; Tasks 2 and 3 are independent of each other.
- `mern-movies/README.md` gets a short index linking every feature README.
