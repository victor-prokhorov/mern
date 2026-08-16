# Password reset

## What this is

A self-service flow that lets a user who forgot their password prove control of their email address and set a new one, without a support agent or an admin ever touching the account. It is the standard "forgot password" link, minus the email delivery.

## How it works here

1. `POST /api/auth/forgot-password { email }` is routed in `routes/auth.js:10` to `controllers/passwordReset.js`'s `forgotPassword`, which calls `services/passwordReset.js:17` `forgotPassword(email)`.
2. The service looks the user up by email (`repositories/users.js`, `findByEmail`). If no user matches, it returns the generic message immediately (`services/passwordReset.js:19`) and does nothing else. This is a real, disclosed gap, not a solved problem: the unknown-email path skips `crypto.randomBytes` and the database insert that the known-email path performs, so the two paths take measurably different time and do measurably different work. A patient, well-positioned attacker could in principle use that difference to enumerate emails even though the response bodies are identical. A hardened implementation either does the same random-byte-generation-and-insert work on the unknown-email path too (writing a token tied to no user, purely to burn the same time and I/O), or pads the response to a fixed minimum latency so the two paths converge.
3. If the user exists, it generates 32 random bytes with `crypto.randomBytes` (`services/passwordReset.js:20`), hex-encodes them into the raw token, SHA-256 hashes that raw token (`hashToken`, `services/passwordReset.js:13-15`), and stores only the hash plus a 15 minute expiry (`TOKEN_TTL_MS`, `services/passwordReset.js:8`) in a `PasswordReset` document (`repositories/passwordResets.js:3-5`, model at `models/passwordReset.js`). The raw token is never written to the database. 32 bytes is 256 bits of entropy from the OS CSPRNG, comfortably past the 128 bits RFC 4086 (BCP 106) treats as the ceiling for practical brute-force resistance — the margin is free here, so there is no reason to shave it. Note that hashing a reset token with plain SHA-256 is correct and is *not* the mistake that hashing a password with plain SHA-256 would be: the fast-hash prohibition exists because passwords are low-entropy and guessable, and a 256-bit random value is neither.
4. There is no mail sender in this app, so delivery is faked, and only as an explicit opt-in: when `process.env.EXPOSE_RESET_TOKEN === '1'`, the raw token is logged to the server console and handed back in the HTTP response body (`services/passwordReset.js:24-27`) so the flow is testable end to end without an inbox. This app's test script sets that flag; a deployed instance should never set it. The gate is an opt-in flag, not a check against `NODE_ENV !== 'production'`, deliberately: an unset or misspelled `NODE_ENV` (the single most common production misconfiguration) would fail open under a negative check and start leaking live reset tokens to logs and API responses. An opt-in flag fails closed by default instead — if it's absent for any reason, nothing leaks.
5. `POST /api/auth/reset-password { token, password }` hits `resetPassword` (`services/passwordReset.js:31`). It re-hashes the incoming raw token and calls `passwordResets.consumeToken(tokenHash, now)` (`repositories/passwordResets.js:7-13`), a single `findOneAndUpdate({ tokenHash, usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } })`. If no document matches — unknown hash, already used, or expired — it returns nothing and the service throws the exact same `BadRequestError('reset token is invalid or expired')` (`services/passwordReset.js:36`) for all three cases. Consuming and validating in one atomic database operation (rather than reading the record, checking it, and writing `usedAt` in a second step) closes a real race: two concurrent requests with the same token cannot both read "not yet used" before either write lands, because MongoDB serializes `findOneAndUpdate` calls against the same document — only one of two simultaneous requests can match `usedAt: null`.
6. On success it runs three more sequential writes, and their order is the safety mechanism: first it revokes every session belonging to that user (`sessions.revokeAllForUser`, `services/passwordReset.js:37`, `repositories/sessions.js`), then it bcrypt-hashes the new password at cost 10 (`services/passwordReset.js:38`) and writes it via `users.updatePasswordHash` (`services/passwordReset.js:39`, `repositories/users.js`), then it invalidates every other outstanding reset token belonging to that user (`services/passwordReset.js:40`, `repositories/passwordResets.js:15-17`) so an older, still-live token from a previous request can't be replayed after a newer flow already changed the password. Counting the token consumption, that is four separate, non-transactional writes — this app's standalone `mongod` has no multi-document transactions to wrap them in (the same constraint [`../session/README.md`](../session/README.md) documents for rotation) — so ordering is the only tool available, and it is pointed at the failure that matters. A crash after the revocation but before the hash write fails safe: the password is unchanged, the sessions are dead, and the user retries the flow with a fresh token — an attacker gains nothing. The reverse order (hash write first, revocation after) failed unsafe: a crash between the two changed the password while leaving an attacker's already-established sessions alive, which is precisely the compromise the revocation exists to end.

**Password policy, and where this app still falls short.**

- **Minimum length 15** (`MIN_PASSWORD_LENGTH`, `services/passwordReset.js:9`, enforced at `services/passwordReset.js:32`). The number is not arbitrary and not a preference. NIST SP 800-63B-4 (final, 26 August 2025) §3.1.1.2: verifiers "**SHALL** require passwords that are used as a single-factor authentication mechanism to be a minimum of 15 characters in length", and **MAY** allow eight "only... as part of multi-factor authentication processes". This app has no second factor, so the single-factor rule is the one that applies and 15 is the floor. It previously enforced 8, which is the multi-factor number — the right rule from the wrong row of the table, and the most common way to be confidently non-compliant while quoting the right document. The error message is derived from the constant so the policy and the text it reports cannot drift apart.
- The check runs *before* the token lookup (`services/passwordReset.js:32` precedes `consumeToken` at `:35`), so a too-short password is rejected even when the token is also invalid. That ordering is deliberate: it costs one string comparison and avoids consuming a valid single-use token on a request that was going to fail anyway.
- **The seeded fixture would fail this rule.** `seedUser.password` is `demo1234` (`src/seed.js:24`) — eight characters, seeded directly as a bcrypt hash without passing through this endpoint. It is left as-is because it predates the policy and only *new* passwords are subject to it, which is exactly how a real rollout works: you raise the floor for changes and let existing credentials age out or get forced. Do not read the fixture as an endorsement. It is a password this application would now refuse to let you set.
- **No breached-password screening**, which the same NIST section makes a **SHALL**: "verifiers **SHALL** compare the prospective secret against a blocklist that contains known commonly used, expected, or compromised passwords". This is the larger remaining gap. Length is the cheaper of the two to fix and the less effective; the blocklist is what actually stops the passwords attackers try first, and a compliant length does nothing at all against a 15-character password that has already appeared in a breach corpus.
- **bcrypt cost 10** (`services/passwordReset.js:38`). Still *inside* current guidance but sitting on its floor: OWASP's Password Storage Cheat Sheet says the work factor "should be as large as verification server performance will allow, with a minimum of 10". The same sheet puts bcrypt third in preference order — Argon2id first (m=19456 KiB, t=2, p=1 as the minimum recommended configuration), scrypt second (N=2^17, r=8, p=1), bcrypt for legacy systems, PBKDF2 when FIPS compliance forces it. What Argon2id buys over bcrypt is memory hardness: bcrypt's 4 KiB working set fits trivially in GPU and ASIC silicon, so an attacker parallelises cheaply; Argon2id's tunable memory cost makes each guess expensive in RAM as well as cycles, which is much harder to buy in bulk. Cost 10 in 2026 is a defensible floor for an existing system that already uses bcrypt everywhere, and a poor choice for a new one.
- Related, and unhandled here: bcrypt truncates its input at 72 bytes. This code applies no maximum length, so two passwords sharing their first 72 bytes hash identically. The usual fix — pre-hashing with SHA-256 before bcrypt — introduces null-byte truncation and password-shucking problems of its own; OWASP's recommended form is `bcrypt(base64(hmac-sha384(password, pepper)), salt, cost)` with the pepper stored outside the database. Enforcing a maximum length is the simpler answer for a system that does not need to accept arbitrarily long passphrases.

## The core concepts

- **Single-use token**: a reset credential that is only good once; consuming it (`usedAt`) prevents replay even if it leaked.
- **Token hashing at rest**: store a one-way hash of the secret, not the secret itself, so a stolen database dump does not hand out working reset links.
- **Expiry window**: a short lifetime (here 15 minutes) bounds how long a leaked or intercepted token stays dangerous. There is no authoritative number for a reset link — OWASP's Forgot Password cheat sheet says only that tokens should "expire after an appropriate period" and declines to name one. The closest thing to a normative figure is NIST SP 800-63B-4 §3.1.3.2, which requires an out-of-band authentication to be "considered invalid unless completed within 10 minutes"; a reset link is not formally an out-of-band authenticator, so treat that as the neighbourhood rather than the rule. The real tradeoff is mundane: too short and a user who reads mail on a delay has to start over, too long and a link sitting in an unattended inbox stays live. Minutes, not hours.
- **User enumeration**: an attacker learning which emails have accounts by watching how an endpoint's response differs for existing vs. non-existing addresses. OWASP's testing guide (WSTG-IDNT-04) catalogues the channels this leaks through, and they are not only message text: status codes, redirect targets, page titles, and response *timing* all serve. Its note on timing is directly on point for this app — sending mail "can add several hundred milliseconds to the response", which is a far larger signal than the microseconds of difference in hashing work.
- **Uniform error / response**: making every code path produce byte-identical output so there is nothing to distinguish and enumerate on. "Identical" has to include the status code and the latency, not just the body.
- **The enumeration-versus-usability tradeoff**: a generic "if that email exists, a link has been sent" is worse for the honest user who mistyped their address and now has no idea why no mail arrived. Some products accept the leak and say "no account with that address" because their user base is public anyway, or because a signup form leaks the same fact regardless. OWASP does not hedge on this — "Return a consistent message for both existent and non-existent accounts" is the first item on its Forgot Password cheat sheet, with no usability carve-out offered. The honest position is that the tradeoff is real and OWASP has already made the call; if you deviate, deviate knowing that your registration and login endpoints have to leak the same way, or the inconsistency between them becomes the oracle instead.
- **Timing attack**: inferring a secret's correctness from how long a comparison takes, when the comparison short-circuits on the first mismatched byte.
- **Session invalidation on reset**: a real system logs out every other active session when the password changes, so a stolen session cookie stops working immediately. The reason this matters is that a reset is usually a *response to compromise*: the user is resetting precisely because they think someone else has their password, and whoever had it has probably already logged in. A reset that changes the password but leaves the attacker's session alive has not evicted anyone. This app now does this: `resetPassword` calls `sessions.revokeAllForUser` immediately before the password hash write — step 6 above explains why that order, and not the reverse, is the crash-safe one. The precision worth keeping straight is *which* half of the session is dead immediately: the refresh token is checked against the `Session` collection on every rotation, so it stops working the moment `revokedAt` is set. The access token is a stateless, signed JWT that nothing in `requireAuth` looks up against the database — see `middleware/auth.js` — so an already-issued access token keeps authorizing requests until its own 15-minute expiry, reset or no reset. That is the stateless-JWT tradeoff [`../session/README.md`](../session/README.md) already teaches: revocation is immediate for the refresh token and only ever eventual, bounded by `ACCESS_TOKEN_TTL_SECONDS`, for the access token.

## Standard practice

- Always return the same status and body whether or not the email exists — otherwise the endpoint becomes an email-validity oracle.
- Store only a hash of the reset token, never the raw value — matches how passwords themselves must be stored.
- Expire tokens quickly (minutes, not days) — a reset link is a bearer credential; the shorter its life, the smaller the exposure window if it leaks.
- Make a token single-use and invalidate siblings on success — otherwise an old, forgotten link stays a live backdoor.
- Return one identical message for "no such token", "expired", and "already used" — three different messages let an attacker fingerprint which tokens are real, which is the same enumeration problem one level down.
- Rate limit both endpoints, but for different reasons and with different keys (see [`../rateLimit/README.md`](../rateLimit/README.md)). `/forgot-password` is limited 3 requests per hour per email (`app.js:16`, `app.js:24`) — that key protects the *credential*: without it, the endpoint is a script for testing which emails are registered, and a way to spam a victim's inbox. `/reset-password` is limited 10 requests per hour per IP (`app.js:17`, `app.js:25`) — that key protects the *resource*, not a credential: the token being checked is a 256-bit random value, so there is no realistic brute force of it to defend against, but an unlimited endpoint is still free compute and database load for anyone to throw junk requests at.
- Compare secrets in constant time, or avoid a manual comparison altogether by relying on an indexed exact-match database lookup. This code takes the second path: `consumeToken` (`repositories/passwordResets.js:7-13`) does an indexed equality lookup (`{ tokenHash, usedAt: null, expiresAt: { $gt: now } }`), not a byte-by-byte JS comparison of two strings. There is no `crypto.timingSafeEqual` call in this code because there is no JS-level string comparison to protect — the attacker would need to guess a 256-bit SHA-256 preimage of a 32-byte random value, which timing information about a database index lookup does not meaningfully help with. A design that instead loaded all outstanding tokens and compared candidate hashes in application code would need `crypto.timingSafeEqual` for that comparison.
- Invalidate other sessions when the password changes. **This app now does.** `services/passwordReset.js`'s `resetPassword` calls `sessions.revokeAllForUser(record.user, now)` (`repositories/sessions.js`) immediately before the write of the new password hash, revoking every session belonging to that user regardless of family. Before this, `Session` rows were keyed by `familyId` with a `sessions.revokeFamily` already written and already used by logout and by refresh-token reuse detection, and `resetPassword` never called it — so an attacker who logged in with the stolen password before the reset kept a valid refresh token afterwards and could rotate it indefinitely; the reset changed the credential they no longer needed. That was a real, live bug, not a scope decision, and it is exactly the kind of thing worth watching for: this README used to describe the gap correctly, and a *correct* description of an unfixed bug still lets the bug ship, because a passing test suite and an accurate paragraph both look like "handled" from a distance. The fix only happened when someone read the paragraph and changed the code to match it, rather than treating the paragraph as the deliverable.
- Never log the raw token, in any environment, for any reason — a reset token is a bearer credential exactly as sensitive as the password it resets, and stdout/log aggregators are rarely treated with the same access controls as the primary database. This app's own console log of the raw token (`services/passwordReset.js:25`) is only acceptable because it is gated behind an opt-in flag meant strictly for local development and this test suite; it should never be reachable in a deployed environment (see the `EXPOSE_RESET_TOKEN` note above).
- Never accept a password reset via email content that includes the new password itself, or via "security questions" — see below.
- Enforce a length floor that matches your actual authentication design — 15 characters for single-factor, 8 only alongside a second factor — and screen the new password against a breached-password corpus at the moment it is set. This endpoint is one of the two places where a password enters the system, so a policy that is only enforced at registration is not enforced. Note which row of the table applies to you before quoting a number: an app with no MFA that enforces 8 is citing NIST correctly and complying with the wrong requirement.
- Impose no composition rules. NIST SP 800-63B-4 §3.1.1.2 is unambiguous: verifiers "**SHALL NOT** impose other composition rules (e.g., requiring mixtures of different character types)". The same section also forbids arbitrary periodic rotation ("**SHALL NOT** require subscribers to change passwords periodically", while still requiring a forced change on evidence of compromise), forbids unauthenticated-readable password hints, and forbids prompting for knowledge-based authentication. All four were once standard advice, all four are now prohibited, and a README repeating any of them would be teaching the 2015 rules.

## What this toy skips

- No real email delivery, so no protection against an attacker with read access to the victim's inbox, and no click-tracking or link-scanning defenses that real email links contend with.
- `/reset-password`'s IP-keyed limit is resource protection, not a real defense against a determined, distributed attacker — 10 requests per hour per IP does nothing to stop the same attack spread across many IPs, and it isn't meant to: guessing a 256-bit token isn't feasible at any rate limit's worth of requests. A production deployment should still watch for and alert on sustained volume against this endpoint even though the limiter itself isn't the thing preventing a token guess.
- No account lockout, no CAPTCHA, no device fingerprinting or new-device confirmation email.
- No audit log of who requested or performed a reset, and no alerting on repeated failed reset attempts.
- No breached-password screening, which NIST SP 800-63B-4 §3.1.1.2 makes a **SHALL** — the largest remaining gap in the password policy, and unlike the length floor it needs a corpus and a lookup rather than one comparison.
- No maximum password length, so bcrypt's 72-byte truncation applies silently.
- A TTL index on `PasswordReset`. **This app now has one.** `models/passwordReset.js:6` carries `expiresAt` with `expires: 0`, the same MongoDB TTL index the sibling models already used (`RateLimit`, `IdempotencyKey`), so used and expired token rows are physically deleted instead of only being excluded by every query (`consumeToken` filters on `usedAt`/`expiresAt`). Before this, the collection grew forever; this model just never got the index its siblings had. The same 60-second-sweep caveat from [`../rateLimit/README.md`](../rateLimit/README.md) applies — expiry is not instant deletion, and it does not need to be, because nothing here reads a row by "is it expired."
- No second factor anywhere, which is why the single-factor 15-character floor is the applicable one. MFA is the change that would move this app's authentication security most, and the length rule exists partly because it is absent.
- The length floor is enforced only here, on reset. There is no registration endpoint in this app, but in a real one the same policy would have to be enforced at every point a password can be set, from one shared place.
- "Security questions" as a reset mechanism are not implemented, deliberately: they are static, often guessable or researchable (mother's maiden name, first pet), rarely rotated, and shared across services, making them a weaker secondary factor than a time-boxed emailed token. This is now prohibited rather than merely discouraged — NIST SP 800-63B-4 §3.1.1.2 states that verifiers "**SHALL NOT** prompt subscribers to use knowledge-based authentication (KBA) (e.g., 'What was the name of your first pet?') or security questions when choosing passwords". OWASP's position is slightly softer, allowing them as a supplement but never as the sole reset mechanism.

## Try it

Start the dev server with the token-exposure flag on, since there is no mailbox to read the token out of (`npm run dev` alone leaves it unset, and then no `token` field comes back):

```bash
JWT_SECRET=dev-secret EXPOSE_RESET_TOKEN=1 npm run dev
```

Then, with the seed data loaded:

```bash
curl -i -X POST http://localhost:5000/api/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@shop.test"}'
```

The response is `202 Accepted` (`controllers/passwordReset.js:4`) — the endpoint is acknowledging a request to send mail it has not sent yet, which is exactly what 202 is for, and it is also the same status for a known and an unknown address. With `EXPOSE_RESET_TOKEN=1` set in the server's environment, the response body includes `token`:

```
HTTP/1.1 202 Accepted
RateLimit-Limit: 3
RateLimit-Remaining: 2
RateLimit-Reset: 532

{"message":"if that email exists, a password reset link has been sent","token":"136a6146..."}
```

Send the same request with an address that has no account and compare: identical `202`, identical `message`, no `token` field. The presence of `token` is the leak, and it exists only because `EXPOSE_RESET_TOKEN` is set; with the flag unset the two responses are byte-identical. Use the token to reset the password:

```bash
curl -i -X POST http://localhost:5000/api/auth/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"token":"<paste the token here>","password":"correct-horse-battery"}'
```

Confirm the new password logs in and the old one doesn't:

```bash
curl -i -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@shop.test","password":"correct-horse-battery"}'
```

Try the same reset request twice with an already-used or unknown token to see the identical `reset token is invalid or expired` message in each case:

```bash
curl -s -X POST http://localhost:5000/api/auth/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"token":"deadbeef","password":"correct-horse-battery"}'
```

Both the replayed token and the nonsense token return `{"error":"reset token is invalid or expired"}` — as does an expired one, which you can reach by waiting out `TOKEN_TTL_MS`. Three distinct failure conditions, one response.

Finally, watch the length floor. Send an eight-character password — the number a great many systems enforce, and the number this app itself used to enforce:

```bash
curl -s -X POST http://localhost:5000/api/auth/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"token":"whatever","password":"eightchr"}'
```

It returns `{"error":"password must be at least 15 characters"}`. Note the token is obvious nonsense and the message still talks about the password: the length check runs before the token lookup, so it answers for an invalid token too. Fifteen characters is accepted:

```bash
curl -s -X POST http://localhost:5000/api/auth/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"token":"<a real token>","password":"fifteenchars123"}'
```

Worth trying against the seeded credentials to see the point land: `demo1234` is the seeded fixture's password and this endpoint will not let you set it. The fixture predates the policy and was written straight to the database as a hash, which is exactly the state a real system is in the day after it raises its floor.

## Further reading

- [NIST SP 800-63B-4, Digital Identity Guidelines: Authentication and Authenticator Management](https://pages.nist.gov/800-63-4/sp800-63b.html) — final since 26 August 2025 and the source that settles most arguments about password policy. Read §3.1.1 end to end: it is short, it is normative, and it prohibits several things that were mandatory advice a decade ago. §3.1.3.2 and §3.2.2 cover out-of-band secret lifetime and failed-attempt throttling.
- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) — the design checklist this flow is built against: consistent messaging for existent and non-existent accounts, consistent *timing*, CSPRNG tokens stored hashed and invalidated after use, per-account rate limiting, and the reasons security questions cannot stand alone.
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) — where the bcrypt cost-10 floor, the Argon2id/scrypt/bcrypt/PBKDF2 preference order, and the concrete parameter sets come from. Also the clearest write-up of bcrypt's 72-byte limit and why naive pre-hashing makes it worse.
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) — the surrounding flow: generic failure messages across login, registration and recovery alike, and the automated-attack defences (MFA first, then lockout and CAPTCHA) that a reset endpoint alone cannot provide.
- [OWASP WSTG-IDNT-04: Testing for Account Enumeration](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/03-Identity_Management_Testing/04-Testing_for_Account_Enumeration_and_Guessable_User_Account) — read it as an attacker's checklist rather than a tester's. The timing section is what makes the "measurably different work" caveat in step 2 above more than theoretical.
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) — the section on renewing the session ID after any privilege change is the missing step 7 of this flow — missing in this app's code, not just in its scope, now that there is a session store here to renew.
- [Provos and Mazières, *A Future-Adaptable Password Scheme* (USENIX 1999)](https://www.usenix.org/legacy/event/usenix99/provos/provos.pdf) — the paper that introduced bcrypt, and eleven pages that explain why a password hash has a tunable cost at all. Everything about work factors follows from its argument that hardware gets faster and the hash has to be able to keep up.
- [RFC 4086, *Randomness Requirements for Security* (BCP 106)](https://www.rfc-editor.org/rfc/rfc4086.html) — the reference behind "use the OS CSPRNG and stop thinking about it". §7 on entropy quantity is what justifies calling 256 bits generous rather than merely large.
- [Node.js crypto: `randomBytes` and `timingSafeEqual`](https://nodejs.org/api/crypto.html#cryptorandombytessize-callback) — the two primitives this flow depends on, including which one it deliberately does not need. `timingSafeEqual`'s note that both inputs must be the same length (and that the length itself is not protected) is the detail people get wrong.
- [MongoDB: Atomicity and Transactions](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/) — the single-document atomicity guarantee that makes `consumeToken`'s `findOneAndUpdate` a real defence against double-consumption rather than a hopeful one.
- [`../session/README.md`](../session/README.md) — the session store this flow now revokes on every reset, and the same hashed-token-plus-atomic-single-use-consumption shape one level over, applied to refresh tokens.
- [`../rateLimit/README.md`](../rateLimit/README.md) — why `/forgot-password` is keyed by email and `/reset-password` by IP, and what the limiter's headers do and do not tell the client.
- [`../blocklist/README.md`](../blocklist/README.md) — in particular the residual oracle where a blocked user completes this reset flow successfully and is still refused at login, which is a leak this flow creates and that one inherits.
