# Password reset

## What this is

A self-service flow that lets a user who forgot their password prove control of their email address and set a new one, without a support agent or an admin ever touching the account. It is the standard "forgot password" link, minus the email delivery.

## How it works here

1. `POST /api/auth/forgot-password { email }` is routed in `server/src/routes/auth.js:8` to `controllers/passwordReset.js`'s `forgotPassword`, which calls `services/passwordReset.js:15` `forgotPassword(email)`.
2. The service looks the user up by email (`repositories/users.js`, `findByEmail`). If no user matches, it returns the generic message immediately (`services/passwordReset.js:17`) and does nothing else — no token is created, no timing difference worth exploiting.
3. If the user exists, it generates 32 random bytes with `crypto.randomBytes` (`services/passwordReset.js:18`), hex-encodes them into the raw token, SHA-256 hashes that raw token (`hashToken`, `services/passwordReset.js:11-13`), and stores only the hash plus a 15 minute expiry in a `PasswordReset` document (`repositories/passwordResets.js:3-5`, model at `models/passwordReset.js`). The raw token is never written to the database.
4. There is no mail sender in this app, so delivery is faked: the raw token is logged to the server console (`services/passwordReset.js:22`) and, only when `NODE_ENV !== 'production'`, also handed back in the HTTP response body (`services/passwordReset.js:23`) so the flow is testable end to end without an inbox. In production that line never executes and the token leaves the server only through the (simulated) email channel.
5. `POST /api/auth/reset-password { token, password }` hits `resetPassword` (`services/passwordReset.js:27`). It re-hashes the incoming raw token, looks up a `PasswordReset` by that hash (`repositories/passwordResets.js:7-9`), and rejects if the record is missing, already used, or expired — all three cases throw the exact same `BadRequestError('reset token is invalid or expired')` (`services/passwordReset.js:32`).
6. On success it bcrypt-hashes the new password at cost 10, writes it via `users.updatePasswordHash` (`repositories/users.js`), marks the used token's `usedAt` (`repositories/passwordResets.js:11-13`), and invalidates every other outstanding token belonging to that user (`repositories/passwordResets.js:15-17`) so an older, still-live token from a previous request can't be replayed after a newer flow already changed the password.

## The core concepts

- **Single-use token**: a reset credential that is only good once; consuming it (`usedAt`) prevents replay even if it leaked.
- **Token hashing at rest**: store a one-way hash of the secret, not the secret itself, so a stolen database dump does not hand out working reset links.
- **Expiry window**: a short lifetime (here 15 minutes) bounds how long a leaked or intercepted token stays dangerous.
- **User enumeration**: an attacker learning which emails have accounts by watching how an endpoint's response differs for existing vs. non-existing addresses.
- **Uniform error / response**: making every code path produce byte-identical output so there is nothing to distinguish and enumerate on.
- **Timing attack**: inferring a secret's correctness from how long a comparison takes, when the comparison short-circuits on the first mismatched byte.
- **Session invalidation on reset**: a real system logs out every other active session when the password changes, so a stolen session cookie stops working immediately.

## Standard practice

- Always return the same status and body whether or not the email exists — otherwise the endpoint becomes an email-validity oracle.
- Store only a hash of the reset token, never the raw value — matches how passwords themselves must be stored.
- Expire tokens quickly (minutes, not days) — a reset link is a bearer credential; the shorter its life, the smaller the exposure window if it leaks.
- Make a token single-use and invalidate siblings on success — otherwise an old, forgotten link stays a live backdoor.
- Return one identical message for "no such token", "expired", and "already used" — three different messages let an attacker fingerprint which tokens are real, which is the same enumeration problem one level down.
- Rate limit the endpoint per email and per IP — otherwise it becomes a script for testing which emails are registered, and a way to spam a victim's inbox (see `server/src/rateLimit/README.md`).
- Compare secrets in constant time, or avoid a manual comparison altogether by relying on an indexed exact-match database lookup. This code takes the second path: `findByTokenHash` (`repositories/passwordResets.js:7-9`) does `PasswordReset.findOne({ tokenHash })`, an indexed equality lookup, not a byte-by-byte JS comparison of two strings. There is no `crypto.timingSafeEqual` call in this code because there is no JS-level string comparison to protect — the attacker would need to guess a 256-bit SHA-256 preimage of a 32-byte random value, which timing information about a database index lookup does not meaningfully help with. A design that instead loaded all outstanding tokens and compared candidate hashes in application code would need `crypto.timingSafeEqual` for that comparison.
- Invalidate other sessions when the password changes — this app has no session or token-based auth to invalidate (login just returns the user document), so this step is a no-op here; a real system with JWTs or server sessions must revoke them all on reset, or a stolen session outlives the password change that was meant to kill it.
- Never accept a password reset via email content that includes the new password itself, or via "security questions" — see below.

## What this toy skips

- No real email delivery, so no protection against an attacker with read access to the victim's inbox, and no click-tracking or link-scanning defenses that real email links contend with.
- No IP or email-based rate limiting on these two endpoints by itself (Task 2 in this repo adds it and should be wired to `/forgot-password` and `/reset-password`).
- No session/token store to revoke on reset, because this app doesn't have one — the "invalidate other sessions" step is described but not implemented.
- No account lockout, no CAPTCHA, no device fingerprinting or new-device confirmation email.
- No audit log of who requested or performed a reset, and no alerting on repeated failed reset attempts.
- "Security questions" as a reset mechanism are not implemented, deliberately: they are static, often guessable or researchable (mother's maiden name, first pet), rarely rotated, and shared across services, making them a weaker secondary factor than a time-boxed emailed token. Standard practice today is to drop them entirely in favor of email or a second factor.

## Try it

Start the dev server (`npm run dev`), then, with the seed data loaded:

```bash
curl -i -X POST http://localhost:5000/api/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@shop.test"}'
```

In development the response body includes `token`. Use it to reset the password:

```bash
curl -i -X POST http://localhost:5000/api/auth/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"token":"<paste the token here>","password":"newpassword1"}'
```

Confirm the new password logs in and the old one doesn't:

```bash
curl -i -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@shop.test","password":"newpassword1"}'
```

Try the same reset request twice with an already-used or unknown token to see the identical `reset token is invalid or expired` message in each case.
