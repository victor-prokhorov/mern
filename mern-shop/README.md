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
npm run dev
```

API on `http://localhost:5000`.

### Environment

`.env.example` covers `PORT`, `MONGO_URI`, and a placeholder `JWT_SECRET` —
the placeholder is enough to get the server running locally, but replace it
with a real, random secret before this app runs anywhere but a laptop. Two
more variables matter beyond what `.env.example` ships:

| Variable | Needed for | If unset |
|---|---|---|
| `JWT_SECRET` | signing and verifying access tokens | **the server refuses to start** — `src/session/tokens.js` throws at import rather than fall back to a hardcoded secret. `.env.example` ships a placeholder so this is covered by default. |
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

**Login and checkout used to be broken here, and it was a code bug, not a
setup problem.** Two changes had landed on the server without being
propagated to `client/src/`: `POST /api/auth/login` started returning
`{ user, accessToken, refreshToken }` rather than the user document, and
`pages/Login.jsx` kept storing that whole envelope as if it were the user, so
`user._id` was `undefined` everywhere afterwards and both tokens were
discarded; separately, `POST /api/orders` started requiring
`Authorization: Bearer <accessToken>` and taking identity from the token
([`server/src/session`](server/src/session/README.md)), while `api.js`'s
`placeOrder` kept sending `userId` in the body with no header, so it got
`401 authentication required`. Both are fixed now: `api.js` stores the user
and the two tokens under separate keys (`saveSession`/`loadUser`/
`loadAccessToken`), `placeOrder` sends the access token as a bearer header
and no longer sends `userId`, and a 401 from any authenticated call clears
the stored session and bounces to the login page with a notice, rather than
leaving the UI in a half-logged-in state.

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
