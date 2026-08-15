# Sessions, rotation, and revocation

## What this is

Real identity for checkout. Before this feature, `POST /api/orders` trusted a client-supplied `userId` in the request body — anyone could place an order as anyone. Login now issues a short-lived signed access token and a long-lived opaque refresh token; order placement takes identity from the verified access token and ignores anything the client puts in the body; `POST /api/auth/refresh` rotates the refresh token on every use and detects replay of an already-rotated one by revoking the whole session family immediately.

## How it works here

1. `POST /api/auth/login` (`services/auth.js:17-26`) checks the password, then calls `issueSession` (`services/auth.js:9-15`), which generates a family id (`crypto.randomUUID()`, `services/auth.js:23`), a 32-byte random refresh token (`generateRefreshToken`, `session/tokens.js:20-23`), and a 15-minute HS256 access token carrying `sub` (user id) and `sid` (family id) (`signAccessToken`, `session/tokens.js:8-10`, `ACCESS_TOKEN_TTL_SECONDS`, `session/tokens.js:4`). Only the SHA-256 hash of the refresh token is written to the `Session` collection (`session/tokens.js:16-18`, `repositories/sessions.js:3-5`) — the raw value is returned to the client once and never stored.
2. `POST /api/auth/refresh` (`services/auth.js:28-41`) hashes the presented token and calls `sessions.consumeToken` (`repositories/sessions.js:11-17`), a single `findOneAndUpdate({ tokenHash, usedAt: null, revokedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } })`. This is the same atomic single-use-consumption shape as `repositories/passwordResets.js:7-13`'s `consumeToken`: there is no read-then-write, so two concurrent presentations of the same still-valid token cannot both succeed — MongoDB serializes the two `findOneAndUpdate` calls against the same document, and only one can match `usedAt: null`.
3. If the atomic consume succeeds, `services/auth.js:34` issues a brand new token pair in the **same family** and `services/auth.js:35` records `replacedBy` on the just-consumed session document (`repositories/sessions.js:19-21`) for audit purposes — a full trail of which token replaced which. If it does not succeed — because the token was already used, already revoked, expired, or never existed — `services/auth.js:38-39` looks the record up again and, if it finds one whose `usedAt` is already set and whose family is not yet revoked, revokes the **entire family** (`revokeFamily`, `repositories/sessions.js:23-25`, a single `updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: now } })`). Either way it throws `401 invalid refresh token`. The caller cannot distinguish "your token was already used by someone else" from "your token never existed" from the response — only the side effect (the whole family going dark) reveals which one happened.
4. `POST /api/auth/logout` (`services/auth.js:43-49`) looks up the presented token's family and revokes it unconditionally — logout does not require the token to still be unused, since a client logging out with its current (not-yet-rotated) token is the ordinary case.
5. `requireAuth` (`middleware/auth.js:4-17`) is the only place `req`/`res` appear in this feature. It reads `Authorization: Bearer <token>`, calls `verifyAccessToken` (`session/tokens.js:12-14`), which is `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })`, and on success sets `req.userId` and `req.sessionId` from the token's `sub`/`sid` before calling `next()`. Any verification failure — bad signature, expired, wrong algorithm — throws `401` uniformly; `requireAuth` never queries the database.
6. `routes/orders.js:8` wires `requireAuth` in front of order placement, and `controllers/orders.js:4` builds the service call explicitly from `req.body.cartId`, `req.body.customer`, and `req.userId` — never `req.body.userId`. A client that posts a `userId` for a different account gets an order placed for the account their own access token actually names; the field is silently discarded rather than rejected, which is itself worth noting as a design choice (see below). `idempotency`'s `userIdFrom` moves to `(req) => req.userId` in the same line, so the idempotency scope in `../idempotency/README.md` tracks whichever identity model is currently in force.

## The core concepts

- **Sessions vs. JWTs, stated fairly.** A server-side session (an opaque id the server looks up on every request) can be revoked instantly — delete the row, the session is gone everywhere. A JWT is "stateless" precisely because the server *doesn't* look anything up to validate it; that's the entire performance and scaling win, and it is exactly what makes revocation hard. You cannot delete a fact that has already been cryptographically signed and handed to the client. This app takes neither position purely: the access token is stateless JWT, unrevokable before its own expiry, and the refresh token is a classic server-side session row, revocable instantly. That split is the design.
- **The short expiry *is* the revocation window.** Because `requireAuth` never queries the database (`middleware/auth.js:9-13`), revoking a family does not immediately invalidate an access token already in a client's hands — it invalidates the *ability to get another one*. An access token issued one second before its owner's session is revoked keeps working for up to `ACCESS_TOKEN_TTL_SECONDS` (`session/tokens.js:4`, 15 minutes) longer. Fifteen minutes is not an arbitrary number; it is the maximum blast radius this design is willing to tolerate in exchange for never hitting the database on the hot path. A system that needed tighter revocation would shorten this window (trading more auth traffic) or add a real-time check (trading away the stateless win entirely — see the OWASP JWT cheat sheet's point below on JWTs for sessions).
- **Rotation and reuse detection, with token families.** Every refresh call invalidates the presented token and issues a new one in the same family (`services/auth.js:32-37`). This bounds how long a *stolen* refresh token is useful: if a legitimate client rotates regularly, a copied token is likely to already be used by the time an attacker tries it, at which point reuse detection fires. The signal reuse detection reads is precise: presenting a token whose `usedAt` is already set means two different presentations of the same single-use credential happened, which is only possible if the credential was copied — a legitimate client, having received a new token from its own rotation, has no reason to ever present the old one again. The response — revoke the whole family, not just reject this one request — treats that signal as compromise, not as a benign race, because there is no way from the server's side to tell an attacker's replay from a race between two legitimate copies of the same client; both look identical, so both get the safe (aggressive) response.
- **Why this can look like it punishes the legitimate user, and why that is the correct trade.** If reuse fires, the family is revoked wholesale — including whatever refresh token is *currently* valid for the legitimate owner. Auth0's own description of this pattern is blunt about the cost: "the legitimate user... will then also be denied access... as the server cannot determine who is legitimate versus malicious in a race condition scenario." The alternative — let the presenter with the "right" token through and hope for the best — is the failure mode this feature exists to close.
- **Access tokens carry authorization decisions; refresh tokens do not carry any.** `requireAuth` extracts `sub`/`sid` and nothing else. It cannot see whether the family has been revoked five minutes ago, because it never asks. This is exactly why order placement's authorization check for *account state* (blocked, fraud-checked) still happens inside `services/orders.js`, against the database, on every call — `requireAuth` answers "who does this token claim to be, and is that claim intact," never "is this account currently allowed to buy things."
- **Algorithm confusion and `alg: none`.** `verifyAccessToken` (`session/tokens.js:12-14`) passes `algorithms: ['HS256']` to `jwt.verify`. This is not decoration: the classic JWT attack rewrites the header's `alg` from an asymmetric algorithm (RS256) to a symmetric one (HS256) and signs with the *public* key as if it were an HMAC secret, which a verifier that trusts the token's own `alg` field will happily accept. A second, cruder variant sets `alg: none` and no signature at all, which some libraries historically accepted as "correctly verified." Pinning the accepted algorithm list on the verify call — never reading it from the token — closes both, and it's why RFC 8725 states plainly that a JWT library "MUST NOT use any other algorithms when performing cryptographic operations" than the ones the caller explicitly allowed.
- **`kid` and key rotation.** This app signs with one static secret (`JWT_SECRET`, `session/tokens.js:6`) and never rotates it — a real deployment needs to, because a leaked signing key is forever otherwise. The standard mechanism is a `kid` (key id) header claim naming which key signed a given token, plus a small overlap window where the verifier accepts both the outgoing and incoming key so tokens signed moments before a rotation don't suddenly fail. Auth0's own signing-key rotation docs describe exactly this: the discovery document "will always include both the current key and the next key," so nothing breaks mid-rotation.
- **Why a library, not hand-rolled JWT.** Signature verification, algorithm pinning, and expiry checking are all one-way doors: get any of them subtly wrong and the failure is silent until someone exploits it. `jsonwebtoken` has already had its `alg: none` and algorithm-confusion classes of bugs found, reported, and fixed in public; a hand-rolled version starts from zero on all of that history.
- **What OAuth2/OIDC add.** This feature is a minimal, in-house version of exactly one corner of OAuth2 — the refresh-token grant and its rotation/reuse-detection recommendation (RFC 9700 §4.14). It has no client registration, no scopes, no consent, no third-party delegation, and no identity layer (OIDC) on top of the authorization layer (OAuth2). Reach for the real protocols the moment a third party needs to act on a user's behalf, or a user needs to log into more than one of your own services with one identity — this design only ever answers "is this request from the account it claims to be from," for one first-party app.

## Standard practice

- Keep access tokens short-lived and verify them statelessly — the expiry *is* the revocation mechanism, so it has to be short enough that a compromised token doesn't stay useful for long.
- Store only a hash of the refresh token, exactly as `../passwordReset/README.md` stores only a hash of the reset token — a stolen database dump should not hand out working credentials.
- Rotate the refresh token on every use, and detect reuse of an already-rotated token as the sole necessary and sufficient compromise signal.
- On detected reuse, revoke the whole family, not just the one presented token — an attacker who has stolen a mid-chain token can otherwise keep the family alive from wherever they cloned it.
- Pin the accepted signature algorithm(s) on every verify call and never trust the token's own `alg` header to decide how to check it.
- Put authorization decisions that can change quickly (blocked, fraud flags, plan tier) in a database check on the request path, not in the token — a token is a snapshot at the moment it was issued.
- Rate limit authentication-adjacent endpoints, including the ones that don't take a password. See below — this app does not yet do this for `/refresh`.
- Rotate signing keys with a `kid` header and an overlap window rather than a single static secret with no rotation story.

## What this toy skips

- **`/api/auth/refresh` is not rate limited.** `app.js` limits `/login`, `/forgot-password`, and `/reset-password` (see `../rateLimit/README.md`) but has no limiter on `/refresh` or `/logout`. A refresh token is a 256-bit random value, so brute-forcing one is not the risk; the risk is an unlimited endpoint being free compute and database load for anyone to throw junk requests at — the same resource-protection argument `../passwordReset/README.md` makes for `/reset-password`'s IP-keyed limit. This app has that gap unaddressed on `/refresh`.
- No `kid` header, no JWKS endpoint, no key rotation — one static `JWT_SECRET` (`session/tokens.js:6`) signs everything, with an insecure fallback default if the environment variable is unset. A leaked secret is unrecoverable without rotating it and invalidating every outstanding token at once.
- No device/session listing or per-device revocation UI — a user cannot see "these are my active sessions" or revoke one device without revoking the whole family (there is only one family concept here, not one per device).
- No sliding-window or absolute-maximum lifetime on the refresh token beyond its flat 30-day `expiresAt` — a family that is quietly never revoked stays refreshable indefinitely, one rotation at a time, for 30 days past the *last* rotation, not 30 days from login.
- No token binding / sender constraint (DPoP, mTLS) — a stolen refresh token is fully usable by whoever holds the raw bytes, with no proof that the presenter is the original device. RFC 9700 §4.14 recommends sender-constraining refresh tokens for public clients precisely because rotation alone still leaves a window between theft and reuse detection.
- No audit log of logins, refreshes, or revocations beyond the `Session` collection's own timestamps — no alerting on a burst of reuse-detected revocations, which in production is exactly the signal an attack is underway.
- `requireAuth` never checks the database, by design (see above) — which also means a revoked family's still-unexpired access tokens keep working. This is documented, not hidden, but it is a real gap for anyone expecting revocation to be instant.
- No refresh token binding to a device fingerprint or IP, and no anomaly detection on login (impossible-travel, new-device email) — this app only reacts to reuse of a specific rotated token, nothing softer.

## Try it

Log in and capture both tokens:

```bash
curl -s -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@shop.test","password":"demo1234"}'
```

Use the access token to place an order — note that any `userId` you add to the body is ignored:

```bash
curl -i -X POST http://localhost:5000/api/orders \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <accessToken>' \
  -d '{"cartId":"<a cart id>","userId":"000000000000000000000000","customer":{"name":"Ada","email":"ada@shop.test","address":"1 Main Street"}}'
```

Rotate the refresh token, then try to reuse the old one:

```bash
curl -s -X POST http://localhost:5000/api/auth/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"<refreshToken>"}'
curl -i -X POST http://localhost:5000/api/auth/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"<the same original refreshToken again>"}'
```

The second call returns `401`. Now try the token the first call just issued you — it is also dead, because presenting the stale one revoked the whole family:

```bash
curl -i -X POST http://localhost:5000/api/auth/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"<the newly rotated refreshToken from the first call>"}'
```

Also `401`. Finally, log out and confirm the refresh token stops working:

```bash
curl -s -X POST http://localhost:5000/api/auth/logout -H 'Content-Type: application/json' -d '{"refreshToken":"<a currently valid refreshToken>"}'
curl -i -X POST http://localhost:5000/api/auth/refresh -H 'Content-Type: application/json' -d '{"refreshToken":"<the same refreshToken>"}'
```

## Further reading

- [RFC 8725, JSON Web Token Best Current Practices](https://datatracker.ietf.org/doc/html/rfc8725) — the normative source for pinning accepted algorithms and never trusting the token's own `alg` header; §3.1 and §3.2 are exactly the algorithm-confusion and `none`-algorithm attacks `verifyAccessToken` closes.
- [OWASP JSON Web Token Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_Cheat_Sheet.html) — algorithm whitelisting, why libraries used to accept `alg: none` by default, and its explicit position that JWTs are a poor fit for revocable user sessions without a denylist — which is exactly why this app keeps the refresh token as a real, revocable database row instead of trying to make the access token itself revocable.
- [Auth0: Refresh Tokens — What Are They and When to Use Them](https://auth0.com/blog/refresh-tokens-what-are-they-and-when-to-use-them/) — the clearest public description of rotation-plus-reuse-detection as a "token family" concept, including the honest statement that detected reuse revokes the family wholesale, legitimate holder included.
- [RFC 9700, OAuth 2.0 Security Best Current Practice, §4.14](https://datatracker.ietf.org/doc/html/rfc9700) — the current IETF guidance recommending refresh token rotation (or sender-constraining) for public clients, which is the standards-track version of the pattern this app implements.
- [RFC 6749 §10.4, The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749.html) — the original, older refresh-token security considerations: a compromised refresh token lets an attacker mint access tokens until it expires or is revoked, which is the baseline problem rotation and reuse detection exist to shrink.
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) — session identifier renewal on privilege change and server-side-enforced expiry, the session-based side of the sessions-vs-JWT tradeoff this README states fairly; also referenced from `../passwordReset/README.md` for the same reason.
- [Auth0: Rotate Signing Keys](https://auth0.com/docs/get-started/tenant-settings/signing-keys/rotate-signing-keys) — the `kid`-plus-overlap-window mechanism this app skips entirely, running one static secret instead.
- [`../passwordReset/README.md`](../passwordReset/README.md) — the same hashed-token-at-rest and atomic single-use-consumption shape this feature's refresh token reuses, one level over from password reset tokens to session tokens.
- [`../rateLimit/README.md`](../rateLimit/README.md) — why `/login` is rate limited and `/refresh` currently is not, and what keying by credential versus IP buys against different attack shapes.
- [`../idempotency/README.md`](../idempotency/README.md) — the consequence this feature had on that one: `userIdFrom` in `routes/orders.js:8` reads `req.userId` instead of `req.body.userId` the moment this feature lands.
