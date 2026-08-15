# Hook registry

## What this is

A minimal synchronous pipeline: `register(event, handler)` attaches a function to a named event, `run(event, payload)` calls every handler registered for that event in order, letting each one continue, reject, or rewrite the payload for the next one. Ticket and comment creation run their payload through this pipeline before anything is persisted.

## How it works here

`register` (`src/hooks/registry.js:5`) appends a handler to an array keyed by event name in a module-level `Map` (`src/hooks/registry.js:1`) — registration order is preserved because it is just array push order. `run` (`src/hooks/registry.js:23`) walks that array for the given event, threading a `current` payload through each handler: a handler's return value is inspected for its `action` field, and `continue` (or a thrown error) moves to the next handler with `current` unchanged; `reject` returns immediately from `run` with `{ action: 'reject', reason }`, so no handler after it ever runs; `transform` replaces `current` with `result.payload` before continuing (`src/hooks/registry.js:34-37`). If every handler continues, `run` returns `{ action: 'continue', payload: current }` with whatever the last transform left behind.

Each handler call is wrapped in `withTimeout` (`src/hooks/registry.js:16`), which races the handler against a fixed budget (`HANDLER_TIMEOUT_MS`, `src/hooks/registry.js:3`) and treats a timeout as a thrown error. Both a genuine throw and a timeout are caught in the same place (`src/hooks/registry.js:28-33`): the error is logged and the loop moves on to the next handler as if this one had returned `continue`. This is fail-open by construction — a broken handler degrades moderation, it does not block the request.

`src/hooks/bootstrap.js` registers three handlers on both `ticket:before-create` and `comment:before-create`, in this order: `keywordBlockerHandler` (the Task 3 keyword blocker — scans the payload text, returns `reject` for a `block`-severity match or `transform`s in `moderation: { flagged: true, terms: [...] }` for a `flag`-severity match), `linkLimitHandler` (counts URLs in the body; more than three `transform`s in the same `moderation.flagged` shape, appending `'link-limit-exceeded'`), and `duplicateContentHandler` (rejects if the same author submitted the identical body within the last 60 seconds). `registerModerationHooks` (`src/hooks/bootstrap.js:42`) is called once, at module load, from `src/app.js`.

`create` and `addComment` (`src/services/tickets.js:38`, `src/services/tickets.js:106`) call `runHooks(event, payload)` after the throttle check and before touching the database, and inspect the outcome: `reject` becomes a 400 with `outcome.reason` as the message (`src/services/tickets.js:39`, `src/services/tickets.js:107`); otherwise the (possibly transformed) `outcome.payload` — including any `moderation` field a handler attached — is what gets persisted.

## The core concepts

- **Hooks vs. middleware vs. events vs. webhooks**: middleware (Express's) is tied to the HTTP request/response cycle and runs in route order; an event emitter (`EventEmitter`) is fire-and-forget with no way for a listener to reject or rewrite what triggered it; a webhook is an HTTP callback to a different process, with all the latency and failure modes that implies. This registry is closest to a synchronous, in-process event system where listeners can veto or edit the thing that is happening — closer to a "before save" hook in an ORM than to any of the above.
- **Sync vs. async moderation, and the latency/consistency tradeoff**: running every handler inline, in the request, means the caller's response already reflects the final decision (rejected, flagged, or clean) — simple to reason about, but the request is only as fast as the slowest handler, and a slow external classifier would make every ticket creation slow. An async design (publish the payload, moderate in a worker, update the record afterward) decouples latency from moderation cost, at the price of a window where content exists before its moderation decision is final, and the API surface has to expose that (a `pending` status, a webhook, a poll). This app chooses sync because a teaching example should let you see the whole decision in one response.
- **Idempotency**: this pipeline runs at most once per creation, synchronously, so idempotency here is really about `duplicateContentHandler` rejecting a resubmission (e.g. a client retrying a timed-out request) rather than about handlers being safe to run twice — a hook system with retries would need each handler to be safe to apply more than once to the same payload.
- **Ordering and priority**: handlers run in registration order with no separate priority field. That is a real limitation — it means the order handlers are registered in `bootstrap.js` is the only lever, so a handler that should always run last (or first) has to be registered last (or first) by convention, not enforced by the registry itself.
- **Failure modes and fail-open vs. fail-closed by domain**: this registry is fail-open — a throwing or timing-out handler is skipped and the request proceeds as if that handler said `continue` (`src/hooks/registry.js:28-33`). That is the right default for moderation: if the keyword blocker's database call fails, a support ticket still needs to get filed and reach a human, and a missed flag is far cheaper than blocking every ticket in an outage. A payments hook (fraud check before charging a card) should typically fail closed instead — if the fraud check cannot run, do not charge the card — because there the cost of a false negative (an uncaught bad transaction) is higher than the cost of blocking a good one. The right default is a property of what the hook protects, not a property of "hooks" in general.
- **Timeouts and circuit breakers**: each handler gets a fixed time budget (`HANDLER_TIMEOUT_MS`) so one slow handler cannot stall the whole pipeline indefinitely. There is no circuit breaker here — a handler that times out on every single request still gets tried, and still costs the timeout, on every single request; a production version would track a handler's recent failure rate and stop calling it for a cooldown period once it is clearly unhealthy.
- **Observability of a pipeline that silently mutates content**: a `transform` can change what gets saved without the caller ever being told which handler did it or why (this is deliberate for moderation — see `src/moderation/README.md` on not naming the matched term). That silence is a real observability cost: `console.error` on a skipped handler (`src/hooks/registry.js:31`) is the only trace left when something goes wrong, and there is no structured log of which handler transformed which field on which request. A production pipeline would want each handler's decision (continue/reject/transform, and why) logged with a request ID, even if the caller-facing response stays generic.

## Standard practice

- Keep the contract to exactly three actions (`continue`, `reject`, `transform`) — a handler that can return anything else makes every call site guess at what happened.
- A `reject` always short-circuits, unconditionally — a moderation handler that runs after a rejection could act on content that is never actually going to be saved.
- Catch both thrown errors and timeouts in the same place, and treat them the same way — a handler that hangs and a handler that throws are the same failure from the pipeline's point of view (it didn't get an answer in time), so they should have the same fallback behavior.
- Decide fail-open vs. fail-closed per domain, explicitly, and write down why — "moderation fails open, payments fail closed" is not a rule that generalizes; it has to be re-derived for whatever the next hook protects.
- Register handlers in one place, at startup (`registerModerationHooks`) — scattering `register` calls across the codebase makes "what runs on this event, in what order" impossible to answer by reading one file.

## What this toy skips

- Priority or dependency ordering between handlers — only registration order.
- Circuit breaking for a chronically failing or slow handler — it is retried (and timed out) on every request regardless of recent history.
- Structured, per-handler observability — failures go to `console.error` with no request correlation.
- An async/queue execution mode — the pipeline is synchronous only; see "Sync vs. async moderation" above for what that costs and what it buys.
- Handler-level configuration (e.g., a different timeout budget per handler) — `HANDLER_TIMEOUT_MS` is one global constant.
- Persisting the fact that a handler was skipped due to a timeout/throw anywhere a human could later audit — it is a log line, not a record.

## Try it

```
curl -s -X POST http://localhost:5001/api/tickets \
  -H 'Content-Type: application/json' -H 'x-user-id: <rae id>' \
  -d '{"title":"t","body":"same body twice","priority":"normal"}'

curl -s -X POST http://localhost:5001/api/tickets \
  -H 'Content-Type: application/json' -H 'x-user-id: <rae id>' \
  -d '{"title":"t2","body":"same body twice","priority":"normal"}'
```

The second call returns 400 `{"error":"duplicate submission"}` — the `duplicateContentHandler` rejected it because the same reporter submitted the identical body less than 60 seconds earlier.
