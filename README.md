# mern

Practice repo for MERN-stack apps. Each app is self-contained — its own client
or server, its own dependencies, its own docs.

The apps exist to carry a set of backend topics worth knowing properly. Each
topic has a working implementation, tests that fail when the behaviour breaks,
and a README beside the code covering the concepts, standard practice, what the
toy skips, and further reading.

## Apps

| App | What it is |
|---|---|
| [mern-shop](mern-shop/) | Minimal ecommerce: catalogue, server-side cart, login, orders. Raw HTML from React, no CSS. Plus four security topics. |
| [mern-tickets](mern-tickets/) | Support-ticket API. Workflow state machine, authorization, moderation, throttling. Server only. |
| [mern-movies](mern-movies/) | Movie API. Recommendations and follow/notify fan-out. Server only. |

## Topics

| Topic | Where |
|---|---|
| Password reset | [mern-shop/server/src/passwordReset](mern-shop/server/src/passwordReset/README.md) |
| Rate limiting | [mern-shop/server/src/rateLimit](mern-shop/server/src/rateLimit/README.md) |
| User blocklist | [mern-shop/server/src/blocklist](mern-shop/server/src/blocklist/README.md) |
| Fraud scoring | [mern-shop/server/src/fraud](mern-shop/server/src/fraud/README.md) |
| Workflow, state machines, audit logs | [mern-tickets/server/src/tickets](mern-tickets/server/src/tickets/README.md) |
| Authorization policy engine | [mern-tickets/server/src/policy](mern-tickets/server/src/policy/README.md) |
| Keyword blocking and moderation | [mern-tickets/server/src/moderation](mern-tickets/server/src/moderation/README.md) |
| Throttling | [mern-tickets/server/src/throttle](mern-tickets/server/src/throttle/README.md) |
| Hook pipelines | [mern-tickets/server/src/hooks](mern-tickets/server/src/hooks/README.md) |
| Circuit breaker | [mern-tickets/server/src/circuitBreaker](mern-tickets/server/src/circuitBreaker/README.md) |
| Recommendations | [mern-movies/server/src/recommendations](mern-movies/server/src/recommendations/README.md) |
| Fan-out and notifications | [mern-movies/server/src/notifications](mern-movies/server/src/notifications/README.md) |
| Domain modelling | [mern-movies/server/src/movies](mern-movies/server/src/movies/README.md) |

## Requirements

- Node 20+
- MongoDB on `mongodb://127.0.0.1:27017`

No MongoDB installed locally? Run one in Docker:

```bash
docker run -d --name mern-mongo -p 27017:27017 --restart unless-stopped mongo:7
```

## Running any app

```bash
cd <app>/server
npm install
cp .env.example .env
npm run seed
npm run dev
```

`mern-shop` also has a client:

```bash
cd mern-shop/client
npm install
npm run dev
```

## Tests

```bash
cd <app>/server
npm test        # drops and rebuilds its own <app>-test database on every test
npm run test:ci # same, plus JUnit XML in test-results/
```

252 tests across the three apps (85 shop, 112 tickets, 55 movies). They need a
reachable MongoDB.

## House rules

These are constraints on the exercise, not recommendations for production.

- A closed dependency list per app. No Redis, no rate-limit package, no policy
  engine, no moderation library — the point is building them and understanding
  the tradeoffs, so anything that hides the mechanism is out.
- No comments in source. Explanation belongs in the READMEs, where it can be
  long enough to be true.
- No CSS anywhere. Raw HTML tags only.
- Servers are layered: routes wire, controllers adapt HTTP, services hold rules,
  repositories own every database call. Only repositories import models, and no
  service or repository mentions `req` or `res`.
