# Optimistic concurrency

## What this is

A guard against the lost update problem on a single ticket document: two callers load the same ticket, both send a mutation, and without a version check the second write silently overwrites the first with no error and no trace. `version` (`src/models/ticket.js:13`) is an integer bumped on every successful mutation, `PATCH /api/tickets/:id/status` and `/assignee` require the caller to say which version they last saw, and the write only happens if that is still the current version.

## How it works here

Every ticket carries an explicit `version: { type: Number, required: true, default: 1 }` (`src/models/ticket.js:13`). Mongoose already keeps its own `__v` on every document, but `__v` is a Mongoose-internal field used for array-subdocument bookkeeping and is not enforced against on a plain `updateOne`/`findOneAndUpdate` unless you opt in with `versionKey` options wired through every write path — the behavior this feature needs would be *implied* by the ODM rather than *visible* in the code. `version` is a field this app owns and reads and writes explicitly, so the compare-and-swap below is something you can point at, not something you have to trust Mongoose is doing for you.

`GET /api/tickets/:id` (`src/controllers/tickets.js:25-27`) and every response that hands back a ticket after a write (`create` at `src/controllers/tickets.js:14-18`, `updateStatus` at `:35-39`, `updateAssignee` at `:41-45`) set a strong `ETag` header via `formatETag(ticket.version)` (`src/concurrency/etag.js:3-5`), which renders `version` as `"3"` — quoted, no `W/` prefix, because this is a byte-exact validator over one field, not a cache validator tolerant of insignificant differences.

A mutating request sends that value back as `If-Match`. `readIfMatch` (`src/concurrency/etag.js:7-12`) parses the header into one of three shapes: `{ status: 'missing' }` when the header is absent, `{ status: 'malformed' }` when it does not match `^"(\d+)"$`, or `{ status: 'ok', version }` when it does. The controller (`src/controllers/tickets.js:36`, `:42`) does only this parsing — it never decides what to do about a missing or malformed header itself. That decision is made after authorization, inside the service, by `casWriteOrConflict` (`src/services/tickets.js:78-85`): a missing `If-Match` throws `PreconditionRequiredError` (428), a malformed one throws `BadRequestError` (400), and only a well-formed one reaches the actual write.

The write is `tickets.updateIfVersionMatches(ticket._id, ifMatch.version, update)` (`src/repositories/tickets.js:23-25`), one `findOneAndUpdate({ _id, version: expectedVersion }, { $set: update, $inc: { version: 1 } }, { returnDocument: 'after' })`. The filter and the update happen inside MongoDB as a single operation: the query "does a document with this id and this exact version still exist" and the mutation "change these fields and bump the version" are not two round trips with a gap between them — they are one atomic command. If a concurrent writer already changed `version` in between, the filter matches nothing, MongoDB does nothing, and `findOneAndUpdate` returns `null`, which is the whole signal `casWriteOrConflict` needs: no exception to catch, no partial state to reconcile, just a falsy return value. On a `null`, `casWriteOrConflict` re-reads the ticket (`requireTicket`, `src/services/tickets.js:83`) and throws `PreconditionFailedError('ticket has been modified since the expected version', current.version, current.toJSON())` (`src/services/tickets.js:84`, class at `src/middleware/error.js:37-44`), which the shared error handler turns into `412 { error, version, ticket }` (`src/middleware/error.js:61-63`) — the caller gets back exactly what changed, not just a bare failure.

`transitionStatus` (`src/services/tickets.js:87-97`) and `assign` (`src/services/tickets.js:99-109`) both call `casWriteOrConflict` for their actual write, after `requireTicket` and `authorize` have already run. That ordering is deliberate and is why `test/policy.test.js`'s existing 403 test for an agent transitioning another team's ticket needed no change when this feature landed: authorization and transition-legality are decided against the freshly loaded ticket first, and only a request that clears both ever reaches the precondition check. A forbidden or structurally-invalid request never learns whether it also forgot `If-Match`.

The audit event records which version the write produced, not just that a write happened: `ticketEvents.create({ ..., version: updated.version })` (`src/services/tickets.js:94`, `:107`; field added at `src/models/ticketEvent.js:9`). Given a `status_changed` event with `version: 4`, you know without cross-referencing anything else that this write moved the ticket to version 4 — which write won a race is legible from the audit log alone.

## The core concepts

- **The lost update problem, named.** Two transactions read the same row, each computes a new value from what it read, and each writes its result back; the second write is not wrong on its own terms, it simply has no idea the first write ever happened, so the first write's effect vanishes with no error raised anywhere. This is the specific failure 428 exists to close off: per RFC 6585, "this scenario occurs when a client retrieves a resource's state, modifies it, and sends it back to the server, but a third party has meanwhile altered that same resource on the server," and mandating a conditional request lets the server verify the client's copy is still current before it commits a change over it.
- **Optimistic versus pessimistic locking, and what actually decides between them.** Martin Fowler's Pessimistic Offline Lock acquires a lock before a session touches data at all, so a conflicting session is blocked from starting rather than discovered later — good when conflicts are common, because failure is cheap (you wait) rather than expensive (you redo work). Optimistic Offline Lock instead "assumes that the chance of conflict is low" and validates only at commit time that no one else changed the data since it was read. Fowler's own tradeoff for optimistic locking is about where the failure lands: a long optimistic transaction that fails at the very end wastes all the work the user just did, which is exactly why this API returns 412 immediately, synchronously, on the single write that conflicted — there is no multi-step "business transaction" here to have wasted effort partway through, so the cost Fowler warns about doesn't accumulate. Contention rate is the actual variable that should decide which pattern you reach for: this app expects one agent working a ticket at a time with only occasional overlap, which is exactly optimistic locking's assumption; a shared document that many people edit continuously (a queue-claiming workflow, a live collaborative editor) is pessimistic locking's or CRDTs' territory instead, not this pattern's.
- **Compare-and-swap as one operation, not read-then-compare-then-write.** The mechanism is only correct because the version check and the mutation happen inside a single `findOneAndUpdate` call sent to MongoDB, which guarantees atomic execution on one document (per the MongoDB manual: "both `findAndModify()`... and `updateOne()` atomically update the document"). If this were instead "read the ticket, compare `version` in application code, then issue a separate update," a second writer could slip in during the gap between the compare and the write, and the whole feature would have re-implemented the bug it exists to close — which is exactly what this repo's token bucket (`../throttle/README.md`) and the shop's fixed-window rate limiter guard against with the same shape of atomic operation.
- **ETags, `If-Match`, and the two status codes.** An ETag is an opaque validator identifying one representation of a resource (RFC 9110 §8.8.3); a *strong* validator, as used here, must be byte-identical to be considered a match, which RFC 9110 §8.8.1 requires for any conditional request that needs exact equality rather than semantic equivalence — a weak `W/"..."` validator is explicitly not usable for that. `If-Match` (RFC 9110 §13.1.1) makes the request conditional on the server holding a matching entity-tag, and its own text is unambiguous about the failure mode: "If the selective request header field evaluates to false, the server MUST respond with the 412 (Precondition Failed) status code." 412 is that precondition-failed answer to a conditional request specifically — it means "you told me what you expected to be true about this resource, and it wasn't." 409 Conflict is the broader status for "your request conflicts with the current state of the resource" without being tied to any conditional header at all; this API never returns 409 because every conflict it can detect is, specifically, a failed `If-Match`.
- **Why 428, and why that is the harder default to pick.** A request with no `If-Match` at all is not "conditional and failing," it is not conditional in the first place — nothing was asserted to compare against, so 412 does not apply. 428 Precondition Required exists for exactly this gap, and choosing to require it here (`PreconditionRequiredError`, `src/middleware/error.js:46-51`) is a deliberate rejection of the easier-seeming alternative: silently treating a missing header as "no opinion, go ahead" is last-write-wins with extra steps, and it defeats the entire mechanism for any client that simply never bothered to send the header.
- **Why a version integer beats a last-modified timestamp for this comparison.** A timestamp has real-world granularity — millisecond in practice, but never physically infinite — so two genuinely concurrent writes on a fast enough system, or two writes racing under clock coarsening, can carry the identical timestamp and be indistinguishable by it; a monotonically incrementing integer bumped exactly once per successful write has no granularity problem because it is not a measurement of the physical world, it is a count of writes this document has actually seen. A timestamp is also vulnerable to clock skew between whichever processes or replicas produced it, where an integer counter has none — it only ever moves by being incremented inside the same atomic operation that performs the write.
- **What this does not solve: whole-document conflict, not field-level conflict.** The version is one number for the entire ticket document. If one agent's request changes `status` and a different agent's concurrent request changes `assignee`, these are, semantically, non-conflicting edits to different fields — and this mechanism rejects one of them anyway, because both requests read the same `version` and only one write can advance it. Field-level merge (detecting that two writes touched disjoint field sets and letting both through) or CRDTs (data types with merge rules designed so concurrent updates from different replicas converge to the same state without either being rejected, as surveyed in Shapiro et al.) are the next step if that false-positive rejection rate becomes a real cost; neither is implemented here.

## Standard practice

- Make the compare-and-swap one database operation, never read-then-compare-then-write in application code — a gap between the compare and the write is exactly the race this feature exists to close, and this repo has shipped that mistake twice already.
- Reject a missing precondition on a mutating endpoint instead of treating it as implicit permission — 428 exists so "the client forgot to send `If-Match`" and "the client's version is current" are different, checkable facts instead of the same silent success.
- Return the current state on 412, not just a bare failure — a client that only learns "you lost" without learning what changed has no way to retry deliberately; it can only guess or re-fetch and hope.
- Bump the version inside the same atomic write that changes the data, never as a separate statement — anything else reopens a gap between the two updates.
- Record the resulting version on the audit trail alongside the mutation, not just the before/after values — the version is what tells you which of several racing writes actually won.
- Prefer a version counter over a last-modified timestamp when the comparison must be exact — see "core concepts" for the granularity and clock-skew reasons why.
- Decide contention rate first, mechanism second — reach for optimistic locking when conflicts are rare and a rejection is cheap to retry; reach for pessimistic locking, or a different data model entirely, when they are not.

## What this toy skips

- Field-level conflict detection or three-way merge — see "core concepts" above; this locks the whole document on one counter.
- CRDTs or any convergent-merge data type — every conflict here is resolved by rejecting one writer, never by combining both writers' intent.
- Retrying a losing write automatically. The token bucket (`../throttle/README.md`) retries its own compare-and-swap internally because a losing attempt there is expected and cheap; a 412 here is returned straight to the caller instead, because retrying a stale ticket mutation on the client's behalf could silently apply a decision to a ticket the human never actually saw in its current state.
- A wildcard `If-Match: *` ("apply regardless of version, just tell me the resource exists"). `readIfMatch` only recognizes a quoted integer and treats anything else, including `*`, as malformed.
- Versioning anything below the whole ticket document — comments and ticket events are never version-checked; only `status` and `assignee` mutations on the ticket itself go through this path.
- Optimistic concurrency on `POST /api/tickets/:id/comments` — a new comment does not conflict with anything else in the way a mutation of existing state can, so there is nothing here for a version check to protect.

## Try it

Two terminals, or two curls fired close together — either way, this creates a ticket, fetches its `ETag`, and then races two updates against the same version:

```bash
RAE_ID=<rae id>
GALE_ID=<gale id>

created=$(curl -s -X POST http://localhost:5001/api/tickets \
  -H 'Content-Type: application/json' -H "x-user-id: $RAE_ID" \
  -d '{"title":"t","body":"racing this one","priority":"normal"}')
ticket_id=$(echo "$created" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))._id')

curl -s -X PATCH "http://localhost:5001/api/tickets/$ticket_id/status" \
  -H 'Content-Type: application/json' -H "x-user-id: $GALE_ID" -H 'If-Match: "1"' \
  -d '{"status":"triaged"}' & \
curl -s -X PATCH "http://localhost:5001/api/tickets/$ticket_id/status" \
  -H 'Content-Type: application/json' -H "x-user-id: $GALE_ID" -H 'If-Match: "1"' \
  -d '{"status":"triaged"}' & \
wait
```

One prints the updated ticket at `200` with `"version":2`; the other prints `412` with the current version and ticket already at the winner's state, copied verbatim from a real run:

```json
{"moderation":{"flagged":false,"terms":[]},"_id":"6a80b5c0d3b56261b6f9ecfb","title":"t","body":"racing this one","status":"triaged","priority":"normal","reporter":"6a80b456c5aae7e8deb25292","assignee":null,"teamId":"team-a","dueAt":"2026-08-18T18:53:52.959Z","version":2,"createdAt":"2026-08-15T18:53:52.959Z","updatedAt":"2026-08-15T18:54:04.557Z","__v":0}
{"error":"ticket has been modified since the expected version","version":2,"ticket":{"moderation":{"flagged":false,"terms":[]},"_id":"6a80b5c0d3b56261b6f9ecfb","title":"t","body":"racing this one","status":"triaged","priority":"normal","reporter":"6a80b456c5aae7e8deb25292","assignee":null,"teamId":"team-a","dueAt":"2026-08-18T18:53:52.959Z","version":2,"createdAt":"2026-08-15T18:53:52.959Z","updatedAt":"2026-08-15T18:54:04.557Z","__v":0}}
```

Missing the header entirely gets you `428`, not a silent write:

```bash
curl -i -X PATCH "http://localhost:5001/api/tickets/$ticket_id/assignee" \
  -H 'Content-Type: application/json' -H "x-user-id: $GALE_ID" \
  -d "{\"assigneeId\":\"$GALE_ID\"}"
```

```
HTTP/1.1 428 Precondition Required
...
{"error":"If-Match header is required"}
```

## Further reading

- [RFC 9110 §13.1.1, HTTP Semantics: If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match) — the conditional header itself, and the sentence that pins 412 to a failed match.
- [RFC 9110 §8.8.3, HTTP Semantics: ETag](https://www.rfc-editor.org/rfc/rfc9110.html#name-etag) — the validator this feature reuses, plus §8.8.1's strong-vs-weak comparison rule for why this app never emits a `W/` tag.
- [RFC 6585 §3, Additional HTTP Status Codes: 428 Precondition Required](https://www.rfc-editor.org/rfc/rfc6585.html) — the status code's defining text, including the lost-update scenario it was written to close.
- [Martin Fowler, Optimistic Offline Lock](https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html) — the pattern this feature is an instance of, and the "chance of conflict is low" assumption that should decide whether to reach for it.
- [Martin Fowler, Pessimistic Offline Lock](https://martinfowler.com/eaaCatalog/pessimisticOfflineLock.html) — the alternative, and the wasted-effort-at-commit-time cost optimistic locking accepts by not using it.
- [MongoDB Manual, `db.collection.findAndModify()`](https://www.mongodb.com/docs/manual/reference/method/db.collection.findAndModify/) — the atomicity guarantee `updateIfVersionMatches` depends on: a single document's filter-then-mutate is one indivisible operation.
- [AWS Developer Guide, DynamoDBMapper Optimistic Locking](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBMapper.OptimisticLocking.html) — the same version-attribute pattern in a different database, including the exact exception (`ConditionalCheckFailedException`) a client sees on the equivalent of this app's 412.
- [Google Cloud Storage, Object versioning: generations and preconditions](https://cloud.google.com/storage/docs/generations-preconditions) — `ifGenerationMatch` is the same compare-and-swap idea applied to blob storage instead of a database row.
- [Shapiro, Preguiça, Baquero, Zawirski, Conflict-Free Replicated Data Types](https://arxiv.org/abs/1805.06358) — what the next step looks like once whole-document rejection is too coarse: data types designed so concurrent writes merge instead of one being discarded.

Elsewhere in this repo: [`../throttle/README.md`](../throttle/README.md) for the token bucket's own compare-and-swap loop (`buckets.updateIfUnchanged`), which retries internally rather than surfacing a conflict to the caller — the opposite choice from this feature, and "What this toy skips" above says why; [`../../../../mern-shop/server/src/rateLimit/README.md`](../../../../mern-shop/server/src/rateLimit/README.md) for the shop's atomic `findOneAndUpdate` with `$inc` and `upsert: true` (`repositories/rateLimits.js:5-9`), the same one-operation-not-two shape applied to a counter instead of a version; [`../observability/README.md`](../observability/README.md) for how a 412 or 428 on this endpoint shows up in the request-scoped structured log.
