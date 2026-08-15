# User blocklist

## What this is

A way to stop a specific account, or any account matching a pattern (an email or a whole domain), from logging in or checking out, without deleting data or touching the database by hand. It is the access-control layer that sits underneath fraud scoring and abuse response.

## How it works here

This app implements two separate mechanisms, deliberately kept apart:

1. **Per-user block** — two fields directly on the account: `User.blockedAt` and `User.blockReason` (`models/user.js:8-9`). Set via `services/blocks.js:52-58` (`blockUser` / `unblockUser`), which call `repositories/blocks.js:20-26` and write straight to the `User` document by its `_id`. This targets one already-known account.
2. **Pattern blocklist** — a separate `BlockEntry` collection (`models/blockEntry.js`) of `{ type: 'email' | 'domain', value, reason, createdBy, createdAt }` records, managed through `POST /api/blocks` and `DELETE /api/blocks/:id` (`routes/blocks.js:6-7`, `controllers/blocks.js:18-28`). This targets an *identifier*, not an account, so it also catches accounts that don't exist yet.

Why two mechanisms instead of one: a per-user block is durable against the user changing their email, because it's keyed by the internal `_id` — the account stays blocked no matter what address they log in with next. A pattern block is durable against the user changing *account* — if `evil@fraud.test` is blocked and they sign up again tomorrow with a new account using the same address (or any address at `fraud.test`), the new account is caught too. Neither mechanism alone covers both evasions; a real system runs both.

3. **Normalization** lives in one place, `services/blocks.js:7-17` (`normalizeEmail`), and both write and read paths call it: `createBlock` normalizes the `value` before storing an email-type entry (`services/blocks.js:40`), and `isBlockedEmail` normalizes the incoming address before comparing (`services/blocks.js:27`). It lowercases, trims, strips anything after the first `+` in the local part, and — only for `gmail.com` / `googlemail.com` — strips dots from the local part, so `Demo+spam@Shop.test` normalizes to `demo@shop.test` and matches a stored block on `demo@shop.test`.

   Two things about that normalization are worth being precise about, because both are places where a convention is being treated as a rule. First, RFC 5321 §2.4 says "the local-part of a mailbox **MUST BE** treated as case sensitive", and §2.3.11 says "the local-part MUST be interpreted and assigned semantics only by the host specified in the domain part of the address". Lowercasing the whole address, and stripping `+tags` for *every* domain rather than only for providers known to use that convention, are both technically outside what the standard permits — a domain is free to run `user+one@` and `user@` as different mailboxes, and this code would collapse them. Universal practice, but not standard-conformant, and the direction of the error matters: over-normalizing makes a block *broader* than intended, which risks catching an innocent party, whereas under-normalizing lets an attacker through. Second, the dot-stripping is correctly scoped: Google documents that "dots don't matter in Gmail addresses", but this is a Gmail behaviour and applying it to other domains would be wrong.

   The same normalization is also not the one the rate limiter uses. `app.js:15-16` builds limiter keys with a bare `.toLowerCase()`. This app gets away with the mismatch only because `users.findByEmail` is itself an exact `findOne({ email })` with no normalization at all, so an aliased address never resolves to an account in the first place — the login path never reaches `isBlockedEmail` with a `+tag` on it. Three different notions of "same email" in one codebase is one too many; the reason to notice it here is that the moment user lookup starts normalizing, the mismatch turns into a real gap.
4. **Enforcement points check account identity, never a checkout-supplied value**: `services/auth.js:11` checks `user.blockedAt` and `isBlockedEmail(user.email)` — the account's *own*, database-backed email — after the password already matched, and — if blocked — throws the exact same `UnauthorizedError('invalid credentials')` (401) as a wrong password (`services/auth.js:10`), so a login attempt against a blocked account is indistinguishable from a login attempt with the wrong password. `services/orders.js:15` runs the identical check — `user.blockedAt` or `isBlockedEmail(user.email)` — before the cart is ever touched, and throws `ForbiddenError('account is not available')` (403, added to `middleware/error.js`) if either is true, so a refused order leaves the cart exactly as it was. Login's 401 and order placement's 403 differ in status and text quite deliberately: login folds a blocked account into the same response as a wrong password because there is a password-shaped response to hide inside; order placement has no such response to borrow, so it uses its own distinct, still-uninformative message instead. The checkout-supplied `customer.email` is deliberately **not** checked here — see the note below on where that value is actually evaluated.
5. **Admin surface**: `controllers/blocks.js:12-16` (`requireAdmin`) compares the `x-admin-token` request header against `process.env.ADMIN_TOKEN` using `crypto.timingSafeEqual` (`controllers/blocks.js:5-10`) rather than `!==`, so a wrong guess cannot be distinguished by response timing — the shared secret is already weak on its own, and there's no reason to add a timing side channel on top of it. It throws `UnauthorizedError` on a missing, wrong, or unconfigured token. `POST /api/blocks` creates a `BlockEntry` (`controllers/blocks.js:18-23`) with `createdBy` taken from an `x-admin-name` header (defaulting to `'admin'`) and `createdAt` defaulted by the schema — that's the audit record. `DELETE /api/blocks/:id` removes an entry (`controllers/blocks.js:25-29`), and its own request is itself only possible with a valid admin token, so unblocking is exactly as gated as blocking.

**Why the account gate ignores the checkout email**: an earlier version of this code checked `isBlockedEmail(customer.email)` at the order-placement gate instead of `user.email`. That was a real bypass — a blocked account could place an order freely just by typing a different email into the checkout form, since nothing about the *account* was ever consulted. It also made the fraud scorer's `BLOCKED_DOMAIN` signal permanently dead: any blocked-domain checkout email was already rejected earlier (with the wrong message) before scoring ever ran. The fix gives each layer exactly one job: this blocklist enforces identity (is *this account* blocked, by itself or by a pattern matching its own email) at a hard, unconditional gate; the checkout-supplied email is evaluated only by the fraud scorer's `BLOCKED_DOMAIN` signal (see [`../fraud/README.md`](../fraud/README.md)), which weighs it alongside other signals instead of hard-gating on it. A checkout email on a blocked domain is still refused end to end — just via `403 order could not be completed` from the fraud layer, not `403 account is not available` from this one.

## The core concepts

- **Block vs suspend vs ban vs shadow-ban**: a block/ban denies access outright and the subject typically knows it (or can find out); a suspension is block framed as temporary and reversible; a shadow-ban lets the subject act normally while their output is hidden from others (used against spam/abuse, ethically contested because it deceives the subject about their own status).
- **Denylist vs allowlist**: a denylist (blocklist) rejects known-bad and allows everything else — cheap to operate, always incomplete. An allowlist accepts only known-good and rejects everything else — much stronger, but only usable when the universe of legitimate identities is small and knowable (e.g. internal service-to-service auth), because it also blocks every legitimate case nobody thought to add.
- **Identifier normalization and evasion**: any identifier-based block is only as strong as the normalization applied before matching. Attackers evade naive exact-match blocks with `+tag` aliases, dot-insertion (Gmail-style providers ignore dots), case changes, and disposable-domain rotation (getting a fresh throwaway domain per signup). Homoglyphs (visually similar Unicode characters, e.g. Cyrillic `а` U+0430 for Latin `a` U+0061) defeat normalization entirely unless the comparison also does confusable detection, which this demo does not attempt. The mechanism for that is standardised: Unicode Technical Standard #39 defines a `skeleton()` transform such that "the strings X and Y are defined to be confusable if and only if skeleton(X) = skeleton(Y)", plus restriction levels that let an application refuse mixed-script identifiers outright. Note that confusable detection and normalization solve different halves of the problem — a skeleton comparison catches lookalikes, a normalizer catches provider-specific aliasing, and neither substitutes for the other.
- **Registrable domain vs hostname**: matching a blocked domain by exact string means `fraud.test` and `mail.fraud.test` are unrelated values. Getting this right means deciding which label boundary is the one that matters, and that boundary is not derivable from the string — `co.uk` and `github.io` both hand out names one level down. The Public Suffix List exists precisely to answer "at what level can names be registered here", and any serious domain-blocking implementation consults it rather than counting dots.
- **Blocking by IP**: weak on its own for the same reasons IP-only rate limiting is weak (NAT, dynamic and rotating IPs, VPNs) — an IP block inconveniences one household or office and is trivially bypassed by the actual attacker.
- **Audit trail, reversibility, appeals**: every block should record who did it, when, and why (`createdBy`/`createdAt`/`reason` here), and unblocking should be exactly as available as blocking — an irreversible or unaccountable block is a liability, not a control.
- **Not leaking the reason**: the blocked party's own response should never explain *why* they were blocked (it teaches them exactly what to change to evade it next time); the reason is for admins and audit logs, not the API response body.

## Standard practice

- Normalize before you store and before you compare, using the exact same function both times — a normalizer that only runs on write, or only on read, silently stops matching anything.
- Return the same status and message for "wrong password" and "blocked account" wherever the endpoint doubles as an authentication check — otherwise the block itself becomes an oracle an attacker can use to enumerate which accounts are flagged.
- Keep per-user and per-identifier blocking as separate mechanisms — collapsing them either lets a rename escape a block, or lets other legitimate accounts get caught by an over-broad pattern.
- Require every block/unblock to carry `who` and `why` — a block nobody can explain a week later cannot be defended, appealed, or trusted.
- Gate the admin surface with real authorization, not a single shared secret — see [`mern-tickets/server/src/policy/README.md`](../../../../mern-tickets/server/src/policy/README.md) for what an actual authorization system for admin actions looks like; a header secret has none of the properties (per-actor identity, revocation, least privilege) that a real admin control needs, even once the comparison itself is constant-time. `crypto.timingSafeEqual` also does not protect the *length* of the secret, which is why `safeEqual` (`controllers/blocks.js:5-10`) returns early on a length mismatch: the length leak is unavoidable, so it is better to be explicit about it than to pretend a padded comparison hides it.
- Normalize to the registrable domain, or match hierarchically, rather than comparing domain strings for equality — otherwise every blocked domain that can issue subdomains is a block in name only.
- Rate limit around blocking-adjacent endpoints too — an unblocked attacker who gets rate limited on login attempts is far less able to probe which of their aliases are still blocked. See [`../rateLimit/README.md`](../rateLimit/README.md).
- Order blocking relative to other defenses deliberately: blocklist checks are typically cheap identity/pattern lookups done first (reject obviously bad actors immediately), rate limiting throttles volume regardless of identity, and fraud scoring runs last as the nuanced, multi-signal judgment call on everything that got this far — see [`../fraud/README.md`](../fraud/README.md). This app's order is exactly that, and you can read it off `services/orders.js:11-31` top to bottom.

## What this toy skips

- No homoglyph or confusable-character detection in `normalizeEmail` — a Cyrillic lookalike domain sails through unnormalized.
- No subdomain matching: a `domain` block on `fraud.test` matches `anyone@fraud.test` exactly but does **not** match `anyone@mail.fraud.test` or any other subdomain, because `findEntryByTypeAndValue('domain', domain)` (`repositories/blocks.js:16-18`) is an exact-string lookup against the domain component only. An attacker who controls DNS for a blocked domain (or abuses a provider that hands out subdomains, e.g. a free hosting service) evades the block for free by registering with a subdomain instead. This is demonstrated in "Try it" below. A real implementation would either store and match domains hierarchically (block the domain and everything under it) or normalize to the registrable domain — the level the Public Suffix List identifies — before comparing.
- No disposable-email-domain list or detection; a `BlockEntry` domain block only stops a domain someone has already told the system about.
- No pagination, search, or listing endpoint for `BlockEntry` — an admin can create and delete by id but cannot list current blocks through this API.
- No rate limiting on the admin endpoints themselves.
- No IP-based blocking at all (deliberately, given how weak it is alone — see above).
- The per-user block (`blockUser`/`unblockUser` in `services/blocks.js`) has no HTTP route in this exercise and no `createdBy`/`createdAt` audit fields on `User` — it's reachable only from other server-side code (and directly in tests). A real system needs an authenticated admin action and an audit record for this path exactly as much as it needs one for the pattern blocklist.
- No notification to the user when blocked, and no appeals workflow.
- A residual oracle remains even with login folded into the wrong-password response: a blocked user who successfully completes the password-reset flow (proving they still control the account's email) will bcrypt-verify against their *new* password and still get refused at the next login attempt with the same `invalid credentials` message. That refusal, immediately after a reset that is known to have succeeded, is itself a signal that distinguishes "blocked" from "you don't remember your password" — a determined user (or an attacker probing an account they've taken over) can use a successful reset followed by an immediate login failure as a strong hint that the account is blocked rather than merely mistyped. Fully closing this would mean either not letting a blocked account complete a reset at all (a different, also-leaky signal), or making the reset itself silently no-op for blocked accounts while still returning success — this demo does neither and leaves the gap open.

## Try it

Block the email address of an existing account and confirm both login and order placement refuse it, even when the order's checkout email is something else entirely (replace the admin token with whatever `ADMIN_TOKEN` is set to in your environment, and the email with a real seeded account's):

```bash
curl -i -X POST http://localhost:5000/api/blocks \
  -H 'Content-Type: application/json' \
  -H 'x-admin-token: change-me' \
  -d '{"type":"email","value":"demo@shop.test","reason":"known fraud"}'
```

The response is `201` with the stored entry, and note that the `value` came back normalized and `createdBy` was filled in from `x-admin-name` (defaulting to `admin` when the header is absent):

```json
{"type":"email","value":"demo@shop.test","reason":"known fraud","createdBy":"victor","_id":"...","createdAt":"2026-08-15T10:53:47.586Z","__v":0}
```

Save the returned `_id`, then try to log in as `demo@shop.test` — expect `401 { "error": "invalid credentials" }`, identical to a wrong password. Placing an order for that same account returns `403 { "error": "account is not available" }` even when the checkout email is somebody else's entirely, which is the whole point of gating on `user.email` rather than `customer.email`:

```bash
curl -s -X POST http://localhost:5000/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"cartId":"cart-1","userId":"<the blocked account id>","customer":{"name":"Ada","email":"someone.else@elsewhere.test","address":"1 Main Street"}}'
```

Then remove the block:

```bash
curl -i -X DELETE http://localhost:5000/api/blocks/<id> \
  -H 'x-admin-token: change-me'
```

That returns `204` with no body, and login for the account works again immediately.

Try the admin endpoint without a token to see it rejected:

```bash
curl -i -X POST http://localhost:5000/api/blocks \
  -H 'Content-Type: application/json' \
  -d '{"type":"email","value":"x@shop.test","reason":"test"}'
```

Expect `401 { "error": "invalid admin token" }` — the same response as a wrong token, and as a server with no `ADMIN_TOKEN` configured at all.

Now demonstrate the subdomain gap, which is the most useful thing in this file to see for yourself. Block a domain, then place an order with a checkout email on a subdomain of it:

```bash
curl -s -X POST http://localhost:5000/api/blocks \
  -H 'Content-Type: application/json' -H 'x-admin-token: change-me' \
  -d '{"type":"domain","value":"fraud.test","reason":"disposable"}'

curl -s -X POST http://localhost:5000/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"cartId":"cart-1","userId":"<a real user id>","customer":{"name":"Ada","email":"buyer@fraud.test","address":"1 Main Street"}}'

curl -s -X POST http://localhost:5000/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"cartId":"cart-1","userId":"<a real user id>","customer":{"name":"Ada","email":"buyer@mail.fraud.test","address":"1 Main Street"}}'
```

The first order is refused with `403 { "error": "order could not be completed" }` — from the fraud scorer's `BLOCKED_DOMAIN` signal, not from this layer. The second is created. One extra label is the entire evasion.

## Further reading

- [RFC 5321 §2.3.11 and §2.4](https://www.rfc-editor.org/rfc/rfc5321.html#section-2.4) — the two paragraphs that make email normalization harder than it looks: local-parts are case sensitive by the standard, and only the receiving domain may assign them meaning. Read before writing any code that decides two addresses are "the same".
- [Unicode Technical Standard #39, *Unicode Security Mechanisms*](https://www.unicode.org/reports/tr39/) — the standard answer to homoglyph attacks, revision 32 (September 2025). §4 defines the confusable-skeleton algorithm and §5 the restriction levels; between them they are what "do confusable detection" actually means in practice.
- [Public Suffix List](https://publicsuffix.org/) — the data that turns "block this domain and everything under it" from a guess into a lookup. The `list/` page is worth a scroll purely to see how many suffixes are not what you would assume.
- [Google: Dots don't matter in Gmail addresses](https://support.google.com/mail/answer/7436150) — the primary source for the one provider-specific rule this normalizer implements, and a reminder that it is a provider behaviour rather than an email rule.
- [Node.js crypto: `timingSafeEqual`](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b) — the exact contract of the comparison `requireAdmin` relies on, including the length requirement that forces the early return in `safeEqual`.
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) — the case for a single generic authentication failure message across every path, which is why a blocked account and a wrong password return the same 401 here.
- [OWASP WSTG-IDNT-04: Testing for Account Enumeration](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/03-Identity_Management_Testing/04-Testing_for_Account_Enumeration_and_Guessable_User_Account) — the catalogue of side channels that turn a block into an oracle: status codes, redirects, page titles, timing. Useful for judging the residual leak described above.
- [OWASP Credential Stuffing Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html) — on IP blocking specifically: "should not be used as the sole or primary defense due to the ease in circumvention". The clearest short statement of why this app implements no IP blocking at all.
- [Stripe Radar: lists](https://docs.stripe.com/radar/lists) — a production blocklist with everything this one lacks: typed values (email, email domain, card fingerprint, IP, country, BIN), listing and filtering, per-item "when and by whom" audit metadata, automatic population from confirmed-fraud reports, and expiring entries. The detail worth stealing is that allowlist entries expire after 30 days by default, because a stale allowlist is how a fraudster gets a permanent bypass.
- [`mern-tickets/server/src/moderation/README.md`](../../../../mern-tickets/server/src/moderation/README.md) — the same normalize-then-match problem applied to text instead of identifiers, with a fuller treatment of evasion and of the reject/flag/allow three-way outcome.
- [`mern-tickets/server/src/policy/README.md`](../../../../mern-tickets/server/src/policy/README.md) — what the admin gate here should be: a policy decision point with per-actor identity and a reason attached to every decision, instead of one shared header secret.
- [`../fraud/README.md`](../fraud/README.md) and [`../rateLimit/README.md`](../rateLimit/README.md) — the layers either side of this one, and where the checkout-supplied email is actually evaluated.
