# mern-shop

Minimal MERN ecommerce, built to practice the stack. No CSS, no styling — raw
HTML from React.

Every path below, and every path in `docs/`, is relative to this directory.

## Requirements

- Node 20+
- A local MongoDB on `mongodb://127.0.0.1:27017`

## Layout

```
client/   React + Vite, no router, raw HTML tags
server/   Express + Mongoose, layered router / controller / service / repository
docs/     design spec and implementation plans
```

## Server

```bash
cd server
npm install
cp .env.example .env
npm run seed
JWT_SECRET=dev-secret npm run dev
```

API on `http://localhost:5000`.

### Environment

`.env.example` covers `PORT` and `MONGO_URI` only. Three more variables matter,
and the first one is not optional:

| Variable | Needed for | If unset |
|---|---|---|
| `JWT_SECRET` | signing and verifying access tokens | **the server refuses to start** — `src/session/tokens.js` throws at import rather than fall back to a hardcoded secret |
| `ADMIN_TOKEN` | the `POST`/`DELETE /api/blocks` admin surface | every admin request gets `401`, including one sending the right token |
| `EXPOSE_RESET_TOKEN=1` | reading a password-reset token back out of the API response, since there is no mail sender | the reset flow works but there is no way to obtain a token by hand |

`npm test` sets all three itself, so tests do not need a `.env`.

## Client

```bash
cd client
npm install
npm run dev
```

Client on `http://localhost:5173`, proxying `/api` to the server on `:5000`.

**The client's login and checkout are currently broken, and it is a code bug,
not a setup problem.** Browsing, the cart, and product pages work. Checkout does
not. Two changes landed on the server without being propagated to
`client/src/`:

- `POST /api/auth/login` now returns `{ user, accessToken, refreshToken }`
  rather than the user document. `pages/Login.jsx` stores that whole envelope
  as if it were the user, so `user._id` is `undefined` everywhere afterwards,
  and both tokens are discarded.
- `POST /api/orders` now requires `Authorization: Bearer <accessToken>` and
  takes identity from the token
  ([`server/src/session`](server/src/session/README.md)). `api.js`'s
  `placeOrder` still sends `userId` in the body and no header, so it gets
  `401 authentication required`.

The API itself is fine — every curl in the server-side guides works. Use those
until the client is caught up.

## Topics

Six guides live beside the code they describe.

| Topic | Guide |
|---|---|
| Password reset | [`server/src/passwordReset`](server/src/passwordReset/README.md) |
| Rate limiting | [`server/src/rateLimit`](server/src/rateLimit/README.md) |
| User blocklist | [`server/src/blocklist`](server/src/blocklist/README.md) |
| Fraud scoring | [`server/src/fraud`](server/src/fraud/README.md) |
| Idempotency keys | [`server/src/idempotency`](server/src/idempotency/README.md) |
| Sessions, rotation, revocation | [`server/src/session`](server/src/session/README.md) |

## Tests

```bash
cd server
npm test
npm run test:ci
```

`npm test` drops and rebuilds the `mern-shop-test` database on every test, so a
local `mongod` must be running. `test:ci` additionally writes JUnit XML to
`server/test-results/results.xml`.

## Docs

- Design spec: `docs/superpowers/specs/2026-08-14-mern-ecommerce-design.md`
- Plans: `docs/superpowers/plans/`
