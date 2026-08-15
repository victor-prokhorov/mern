# User blocklist

## What this is

A way to stop a specific account, or any account matching a pattern (an email or a whole domain), from logging in or checking out, without deleting data or touching the database by hand. It is the access-control layer that sits underneath fraud scoring and abuse response.

## How it works here

This app implements two separate mechanisms, deliberately kept apart:

1. **Per-user block** — two fields directly on the account: `User.blockedAt` and `User.blockReason` (`models/user.js:7-8`). Set via `services/blocks.js:52-58` (`blockUser` / `unblockUser`), which call `repositories/blocks.js:19-25` and write straight to the `User` document by its `_id`. This targets one already-known account.
2. **Pattern blocklist** — a separate `BlockEntry` collection (`models/blockEntry.js`) of `{ type: 'email' | 'domain', value, reason, createdBy, createdAt }` records, managed through `POST /api/blocks` and `DELETE /api/blocks/:id` (`routes/blocks.js:6-7`, `controllers/blocks.js:9-20`). This targets an *identifier*, not an account, so it also catches accounts that don't exist yet.

Why two mechanisms instead of one: a per-user block is durable against the user changing their email, because it's keyed by the internal `_id` — the account stays blocked no matter what address they log in with next. A pattern block is durable against the user changing *account* — if `evil@fraud.test` is blocked and they sign up again tomorrow with a new account using the same address (or any address at `fraud.test`), the new account is caught too. Neither mechanism alone covers both evasions; a real system runs both.

3. **Normalization** lives in one place, `services/blocks.js:7-17` (`normalizeEmail`), and both write and read paths call it: `createBlock` normalizes the `value` before storing an email-type entry (`services/blocks.js:40`), and `isBlockedEmail` normalizes the incoming address before comparing (`services/blocks.js:27`). It lowercases, trims, strips anything after `+` in the local part, and — only for `gmail.com` / `googlemail.com` — strips dots from the local part, so `Demo+spam@Shop.test` normalizes to `demo@shop.test` and matches a stored block on `demo@shop.test`.
4. **Enforcement points**: `services/auth.js:11` checks `user.blockedAt` and `isBlockedEmail(user.email)` after the password already matched, and — if blocked — throws the exact same `UnauthorizedError('invalid credentials')` (401) as a wrong password (`services/auth.js:10`), so a login attempt against a blocked account is indistinguishable from a login attempt with the wrong password. `services/orders.js:12` checks the placing user's `blockedAt` and the checkout `customer.email` against the pattern blocklist, and — if blocked — throws `ForbiddenError('account is not available')` (403, added to `middleware/error.js`) before the cart is ever touched, so a refused order leaves the cart exactly as it was.
5. **Admin surface**: `controllers/blocks.js:4-7` (`requireAdmin`) compares the `x-admin-token` request header against `process.env.ADMIN_TOKEN` and throws `UnauthorizedError` on a missing or wrong value. `POST /api/blocks` creates a `BlockEntry` (`controllers/blocks.js:9-14`) with `createdBy` taken from an `x-admin-name` header (defaulting to `'admin'`) and `createdAt` defaulted by the schema — that's the audit record. `DELETE /api/blocks/:id` removes an entry (`controllers/blocks.js:16-19`), and its own request is itself only possible with a valid admin token, so unblocking is exactly as gated as blocking.

## A deliberate deviation from the plan, disclosed

The plan's prose says login should refuse a blocked user with "403, message `account is not available`," but its own required-tests list says "the message equals the wrong-password message" — those two instructions contradict each other; 403 with a distinct string cannot equal 401 with `invalid credentials`. This implementation resolves it in favor of the literal, checkable test requirement and the stated goal ("a blocked user must not be able to tell blocking apart from a wrong password"): login returns 401 `invalid credentials` for both a blocked account and a wrong password, with no distinguishing signal at all. The `403 account is not available` wording is instead used at order placement, where there is no password-shaped response to hide behind. This trade-off — and which enforcement point got which behavior — should be confirmed with whoever wrote the plan before this ships past a demo.

## The core concepts

- **Block vs suspend vs ban vs shadow-ban**: a block/ban denies access outright and the subject typically knows it (or can find out); a suspension is block framed as temporary and reversible; a shadow-ban lets the subject act normally while their output is hidden from others (used against spam/abuse, ethically contested because it deceives the subject about their own status).
- **Denylist vs allowlist**: a denylist (blocklist) rejects known-bad and allows everything else — cheap to operate, always incomplete. An allowlist accepts only known-good and rejects everything else — much stronger, but only usable when the universe of legitimate identities is small and knowable (e.g. internal service-to-service auth), because it also blocks every legitimate case nobody thought to add.
- **Identifier normalization and evasion**: any identifier-based block is only as strong as the normalization applied before matching. Attackers evade naive exact-match blocks with `+tag` aliases, dot-insertion (Gmail-style providers ignore dots), case changes, and disposable-domain rotation (getting a fresh throwaway domain per signup). Homoglyphs (visually identical Unicode characters, e.g. Cyrillic `а` for Latin `a`) defeat normalization entirely unless the comparison also does Unicode confusable-detection, which this demo does not attempt.
- **Blocking by IP**: weak on its own for the same reasons IP-only rate limiting is weak (NAT, dynamic and rotating IPs, VPNs) — an IP block inconveniences one household or office and is trivially bypassed by the actual attacker.
- **Audit trail, reversibility, appeals**: every block should record who did it, when, and why (`createdBy`/`createdAt`/`reason` here), and unblocking should be exactly as available as blocking — an irreversible or unaccountable block is a liability, not a control.
- **Not leaking the reason**: the blocked party's own response should never explain *why* they were blocked (it teaches them exactly what to change to evade it next time); the reason is for admins and audit logs, not the API response body.

## Standard practice

- Normalize before you store and before you compare, using the exact same function both times — a normalizer that only runs on write, or only on read, silently stops matching anything.
- Return the same status and message for "wrong password" and "blocked account" wherever the endpoint doubles as an authentication check — otherwise the block itself becomes an oracle an attacker can use to enumerate which accounts are flagged.
- Keep per-user and per-identifier blocking as separate mechanisms — collapsing them either lets a rename escape a block, or lets other legitimate accounts get caught by an over-broad pattern.
- Require every block/unblock to carry `who` and `why` — a block nobody can explain a week later cannot be defended, appealed, or trusted.
- Gate the admin surface with real authorization, not a single shared secret — see the mern-tickets policy README for what an actual authorization system for admin actions looks like; a header secret compared with `===` has none of the properties (per-actor identity, revocation, least privilege) that a real admin control needs.
- Rate limit around blocking-adjacent endpoints too — an unblocked attacker who gets rate limited on login attempts is far less able to probe which of their aliases are still blocked.
- Order blocking relative to other defenses deliberately: blocklist checks are typically cheap identity/pattern lookups done first (reject obviously bad actors immediately), rate limiting throttles volume regardless of identity, and fraud scoring runs last as the nuanced, multi-signal judgment call on everything that got this far — see `server/src/fraud/README.md`.

## What this toy skips

- No homoglyph or confusable-character detection in `normalizeEmail` — a Cyrillic lookalike domain sails through unnormalized.
- No disposable-email-domain list or detection; a `BlockEntry` domain block only stops a domain someone has already told the system about.
- No pagination, search, or listing endpoint for `BlockEntry` — an admin can create and delete by id but cannot list current blocks through this API.
- No rate limiting on the admin endpoints themselves.
- No IP-based blocking at all (deliberately, given how weak it is alone — see above).
- The per-user block (`blockUser`/`unblockUser` in `services/blocks.js`) has no HTTP route in this exercise and no `createdBy`/`createdAt` audit fields on `User` — it's reachable only from other server-side code (and directly in tests). A real system needs an authenticated admin action and an audit record for this path exactly as much as it needs one for the pattern blocklist.
- No notification to the user when blocked, and no appeals workflow.

## Try it

Block a domain and confirm an order using that domain is refused (replace the admin token with whatever `ADMIN_TOKEN` is set to in your environment):

```bash
curl -i -X POST http://localhost:5000/api/blocks \
  -H 'Content-Type: application/json' \
  -H 'x-admin-token: change-me' \
  -d '{"type":"domain","value":"fraud.test","reason":"known fraud domain"}'
```

Save the returned `_id`, then try to check out with an address at that domain — expect `403 { "error": "account is not available" }`. Then remove the block:

```bash
curl -i -X DELETE http://localhost:5000/api/blocks/<id> \
  -H 'x-admin-token: change-me'
```

Try the admin endpoint without a token to see it rejected:

```bash
curl -i -X POST http://localhost:5000/api/blocks \
  -H 'Content-Type: application/json' \
  -d '{"type":"email","value":"x@shop.test","reason":"test"}'
```
