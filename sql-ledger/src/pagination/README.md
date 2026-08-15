# Keyset pagination

## What this is

`GET /api/transfers?limit=&cursor=` pages through transfers newest-first using a **keyset** (a.k.a. seek) cursor — an opaque token encoding the last row's `(created_at, id)` — rather than an `OFFSET`. `GET /api/transfers/offset-demo?limit=&offset=` is a second, deliberately smaller endpoint that exists for exactly one reason: to let the tests demonstrate, against a real Postgres table, that `OFFSET` pagination skips and duplicates rows under concurrent writes while keyset pagination does not. It is not an alternative you should call in real usage — see `src/controllers/transfers.js` and its own naming for the label.

## How it works here

The real endpoint's repository query, `findPageKeyset` (`src/repositories/transfers.js:27-40`), has two shapes: with no cursor, plain `ORDER BY created_at DESC, id DESC LIMIT $1`; with a cursor, the same order but with a **row-value comparison** predicate, `WHERE (created_at, id) < ($1, $2)`. That tuple comparison — not two separate `AND`-ed conditions — is what makes ties on `created_at` safe: Postgres compares row values lexicographically, so `(created_at, id) < (cursorCreatedAt, cursorId)` means "earlier in time, or the same instant but a lower id," which is exactly "strictly after the cursor in this sort order" with no double-counted or skipped boundary row.

`src/pagination/cursor.js` is the only place that touches the cursor's wire format: `encodeCursor` (`cursor.js:3-6`) JSON-encodes `{ c: createdAt, i: String(id) }` and base64url-encodes the result; `decodeCursor` (`cursor.js:8-21`) reverses that and validates the shape before trusting it — a non-base64 string, valid base64 that isn't JSON, JSON missing either field, or a `c` that doesn't parse as a real date all throw `BadRequestError`, which the shared error handler turns into a 400. `id` is round-tripped as a **string**, not a number: Postgres returns `bigint` columns as strings over the wire specifically to avoid silent precision loss past `Number.MAX_SAFE_INTEGER`, and the cursor codec preserves that rather than coercing through a JS number at any point.

`services/transfers.js`'s `listKeyset` (`src/services/transfers.js:49-58`) is the one place that decides the page boundary: it asks the repository for `limit + 1` rows, and if that comes back with more rows than `limit`, there is a next page — it slices back down to `limit` and encodes a cursor from the last row of that slice; otherwise `nextCursor` is `null` and the caller knows this was the last page. `clampLimit` (`src/services/transfers.js:12-16`) treats a missing, non-numeric, or non-positive `limit` as the default (20) and caps any requested value at `MAX_LIMIT` (100) — a client asking for `limit=100000` gets 100 rows back, never all of them.

Migration `006_transfers_created_at_id_index.concurrent.sql` (see `src/migrations/README.md`) builds `transfers_created_at_id_idx ON transfers (created_at DESC, id DESC)` — a composite index whose column order matches the `ORDER BY` exactly, which is what lets Postgres satisfy both the sort and the `WHERE (created_at, id) < (...)` predicate by walking the index in order and stopping at `LIMIT`, rather than sorting the whole table first.

## The core concepts

- **`OFFSET` re-executes the *position*, keyset re-executes the *predicate*.** `OFFSET n` means "compute the full ordered result set, then throw away the first `n` rows" — it re-derives the same position every time, and "position" is only stable if nothing between position 0 and position `n` changes between one request and the next. Keyset instead asks "give me rows after this specific row I already saw," which stays correct regardless of anything that happened before that row.
- **The failure this app proves, concretely.** `test/pagination.test.js` inserts a new row between two `OFFSET` fetches and shows the second page repeats a row the first page already returned (a duplicate); a separate test deletes a row between fetches and shows a row that was never on any page (a skip). Both tests then run the identical before/after sequence through the keyset endpoint and show it returns neither. This is not a hypothetical — it happens on every "load more" click on a live feed.
- **The tuple-comparison predicate needs a matching composite index, or it degrades to a full sort.** `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC` can only avoid sorting the whole table if Postgres has an index whose leading columns are `(created_at, id)` in the same direction as the query — migration `006` exists for exactly this reason. Without it, every page fetch would be a full table sort, which defeats the entire performance argument for keyset pagination in the first place.
- **Stable sort keys, and why ties need a tiebreaker.** `created_at` alone is not unique — two transfers created in the same millisecond tie. Sorting by `created_at DESC` alone would let the database return either one first on any given call, non-deterministically, which can silently duplicate or drop a row across pages exactly like the `OFFSET` failure this pattern is supposed to fix. Appending `id DESC` (a genuinely unique, monotonic column) as the second sort key removes the ambiguity entirely.
- **"Opaque" is doing two different jobs, and this cursor only does one of them.** The first job is *validation*: `decodeCursor` guards against a malformed or nonsensical cursor reaching raw SQL, and a 400 in `src/pagination/cursor.js:13,16,19` is what stands between "invalid input" and either a crash or a query running with a wrong predicate. This app does that. The second job is *contract hiding*, and this app does not do it: base64url of a JSON object is trivially reversible, so `{"c":"2026-08-15T21:52:24.650Z","i":"100"}` is effectively published API surface, and a client that starts constructing its own cursors makes `(created_at, id)` a thing you can no longer change without breaking them. Google's AIP-158 is blunt that this is not enough — page tokens "**must** be opaque (but URL-safe) strings, and **must not** be user-parseable", and "base-64 encoding an otherwise-transparent page token is **not** a sufficient obfuscation mechanism", precisely because "this effectively makes the implementation details of your API's pagination become part of the API surface". Signing or encrypting the token is what closes that, and it is also what makes forgery detectable rather than merely inconvenient. Note the two jobs fail differently: skip validation and you get a crash or a bad query today; skip contract hiding and you get a migration you cannot perform two years from now.
- **Total counts are expensive, and usually a lie anyway.** A `COUNT(*)` alongside a paginated query means scanning (or at best, index-scanning) the entire matching set just to produce a number the client may never need — on a large, growing table that cost only grows. And under concurrent writes, a total computed at the start of pagination is stale by the time the client reaches the last page; presenting it as "the" total misrepresents a number that was only ever true for an instant. This is why the response here carries `nextCursor` and nothing else — there is no `total` field to be honest or dishonest about.
- **Deep pagination as a denial-of-service surface.** Even bounded, `OFFSET 999999999 LIMIT 20` still forces the database to walk (or skip through an index) nearly a billion rows to find the twenty it will return — a client (or a scraper) can cheaply request an expensive query. Keyset pagination has no equivalent: there is no "offset" parameter to inflate, only a cursor that encodes a specific row, so the cost of any single page fetch does not grow with how deep into the result set that cursor happens to be.
- **When offset is genuinely fine.** A small, bounded, rarely-changing dataset (an admin page listing a few hundred config rows), a UI that genuinely needs "jump to page 7" rather than only "next," or internal tooling where nobody cares about perfect consistency under concurrent writes — offset's simplicity (a page number instead of an opaque token) is a real advantage there, and this app's own `offset-demo` endpoint is itself evidence that offset is trivial to build. The failure mode above only matters once the table is large enough or busy enough for "between your two requests" to be a realistic window.

## Standard practice

- Default to keyset/seek pagination for any endpoint over a table that grows and is written to concurrently with being read.
- Always pair the sort key with the query's supporting index — same columns, same direction.
- Include a genuinely unique column (a primary key) as the final tiebreaker in the sort, never rely on a non-unique column like a timestamp alone.
- Validate a client-supplied cursor's shape before it touches a query, and fail with 400 rather than let a malformed cursor reach SQL.
- Don't compute or expose a total count for free alongside a paginated endpoint — treat it as its own, separately-justified query if a caller genuinely needs it.
- Clamp any client-supplied page size to a sane maximum server-side, regardless of what the client asks for.

## What this toy skips

- No signed/HMAC'd or encrypted cursors — this app's cursor is validated for shape, not tamper-evidence, and its base64url-of-JSON payload is fully readable by any client that cares to look. See the "opaque" concept above: this fails the AIP-158 bar, and the cost lands on the day you want to change the sort key.
- No backward pagination (a `prevCursor` / "page back" direction) — only forward, newest-first.
- No support for a caller-supplied sort order — `created_at DESC, id DESC` is the only order this endpoint knows.
- No rate limiting specifically aimed at deep-pagination abuse — the cost argument in "Deep pagination as a denial-of-service surface" above is why keyset avoids the problem structurally, not because this app additionally throttles it.

## Try it

Requires the app running against the real `ledger` database (see the root `README.md`), with at least four transfers already created (see [`../ledger/README.md`](../ledger/README.md)'s Try it section — run its transfer curl a few times with different `reference` values).

Fetch a first page and note the two ids and the cursor:

```bash
curl -s 'http://localhost:5002/api/transfers?limit=2'
```

```json
{"transfers":[{"id":"105",...},{"id":"102",...}],"nextCursor":"eyJjIjoiMjAyNi0wOC0xNVQyMTo1MjoyNC42NTBaIiwiaSI6IjEwMCJ9"}
```

That cursor is the point of the "opaque" discussion above — `base64url --decode` it and you get `{"c":"...","i":"100"}` in plain text. Now reproduce the `OFFSET` bug, which is the whole reason the other endpoint exists. Fetch page one by offset, insert a transfer, then fetch page two:

```bash
curl -s 'http://localhost:5002/api/transfers/offset-demo?limit=2&offset=0'

curl -s -X POST http://localhost:5002/api/transfers -H 'Content-Type: application/json' \
  -d '{"reference":"page-demo-1","fromAccountId":<alice id>,"toAccountId":<bob id>,"amountMinor":1}'

curl -s 'http://localhost:5002/api/transfers/offset-demo?limit=2&offset=2'
```

A real run, showing only the ids: page one returned `102, 101`, and page two returned `101, 100`. **Transfer 101 appears on both pages.** Nothing went wrong in either query — the new row shifted every subsequent row one position later, and `OFFSET 2` faithfully returned whatever was in positions 3 and 4 *of the new ordering*. That is the mechanism, and it is why the same click on "load more" shows you a post you already read.

Now the identical sequence through the keyset endpoint, using the cursor from page one instead of an offset:

```bash
curl -s 'http://localhost:5002/api/transfers?limit=2'

curl -s -X POST http://localhost:5002/api/transfers -H 'Content-Type: application/json' \
  -d '{"reference":"page-demo-2","fromAccountId":<alice id>,"toAccountId":<bob id>,"amountMinor":1}'

curl -s 'http://localhost:5002/api/transfers?limit=2&cursor=<nextCursor from the first call>'
```

Page one returned `105, 102`; page two returned `101, 100`. No duplicate and no gap, because the second request never asked "what is in positions 3 and 4" — it asked "what comes strictly after transfer 102 in this ordering", a question the insert could not change the answer to. The newly inserted row is simply absent from both pages, which is the correct behaviour: it sorts newer than the cursor, so it belongs on a page the client has already passed.

Finally, the guardrails:

```bash
curl -s 'http://localhost:5002/api/transfers?limit=1&cursor=not-a-real-cursor'
curl -s 'http://localhost:5002/api/transfers?limit=9999' | head -c 120
```

The first is `400 {"error":"malformed cursor"}`. The second returns 100 rows, not 9999 — `clampLimit` caps it at `MAX_LIMIT` silently rather than erroring, so a client asking for too much gets a valid answer rather than a failure.

## Further reading

- [Use The Index, Luke — No OFFSET](https://use-the-index-luke.com/no-offset) — the case against `OFFSET` at scale (rows fetched and discarded, non-deterministic results without a stable sort) and the keyset alternative, from the reference site on SQL indexing.
- [Slack Engineering — Evolving API Pagination at Slack](https://slack.engineering/evolving-api-pagination-at-slack/) — a real migration from offset/page-based pagination to opaque cursors at scale, including why "the database still has to read up to `offset + count` rows" even to serve a late page.
- [PostgreSQL documentation — `LIMIT`/`OFFSET`](https://www.postgresql.org/docs/current/queries-limit.html) — the two clauses' actual semantics, including the explicit warning that results are unpredictable without an `ORDER BY`, and that large offsets are inefficient because skipped rows still have to be computed.
- [PostgreSQL documentation — Row Constructor Comparison (§9.25.5)](https://www.postgresql.org/docs/current/functions-comparisons.html) — the exact semantics of `(created_at, id) < ($1, $2)`, which is the single line this whole implementation turns on: "the row elements are compared left-to-right, stopping as soon as an unequal or null pair of elements is found." Read the `NULL` behaviour too, because a nullable sort column would break the predicate in a way the tests here never exercise.
- [Markus Winand — Paging Through Results](https://use-the-index-luke.com/sql/partial-results/fetch-next-page) — the same author as *No OFFSET*, but this is the chapter that shows the index access path side by side for both approaches. Read it if you want to see *why* the composite index makes the seek predicate cheap rather than take it on trust.
- [Google AIP-158 — Pagination](https://google.aip.dev/158) — the API-design side rather than the SQL side, and the source of this README's correction about opacity. Also worth it for `page_size` being optional-with-a-server-default rather than required, which is the behaviour `clampLimit` implements.
- [GraphQL Cursor Connections Specification (Relay)](https://relay.dev/graphql/connections.htm) — the most widely copied wire format for cursor pagination: `edges`/`cursor`/`pageInfo` with `hasNextPage`. Worth reading beside this app's flat `{ transfers, nextCursor }` to see what the extra structure buys (bidirectional paging, per-edge cursors) and what it costs.
- [GitHub REST API — Using pagination in the REST API](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api) — a large public API that offers both, and documents the `Link` header convention plus the cursor-based endpoints it moved to. A useful reality check on how the two coexist in a real product rather than one replacing the other.
- [PostgreSQL documentation — Indexes and `ORDER BY`](https://www.postgresql.org/docs/current/indexes-ordering.html) — why the index's declared direction has to match the query's, and when Postgres can walk an index backwards instead. This is the reference behind "same columns, same direction" in Standard practice.

Elsewhere in this repo: [`../migrations/README.md`](../migrations/README.md) for the `CONCURRENTLY` index migration this endpoint's query plan depends on; [`../ledger/README.md`](../ledger/README.md) for the rows being paged over and where their `created_at` comes from.
