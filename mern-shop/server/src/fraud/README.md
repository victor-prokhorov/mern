# Fraud scoring

## What this is

A rules-based check, run at checkout, that looks at a handful of signals about the order and the account placing it, and decides whether to let the order through, hold it for a human to look at, or refuse it outright. It replaces a single opaque "is this fraud, yes or no" guess with an explainable, adjustable score.

## How it works here

1. `services/orders.js:11` (`place`) runs the existing checks first — invalid user, unblocked-account and unblocked-domain gate (`services/orders.js:15`, from Task 3), cart existence — before fraud scoring ever runs, so a hard block never reaches the scoring step at all. That ordering is deliberate: cheap, unconditional identity checks run first; the more nuanced, weighted judgment call runs last (see `server/src/blocklist/README.md`).
2. Once the order's `items` and `total` are computed, `services/orders.js:26-29` fetches the two pieces of state the signals need but cannot compute themselves: `orderStats.countRecentOrders` (`repositories/orderStats.js:3-5`, a `countDocuments` query for this user's orders in the last hour) and `blocks.isBlockedEmail(customer.email)` (reusing Task 3's blocklist).
3. `services/orders.js:30` calls `evaluateSignals({ user, cart, customer, stats })` (`fraud/signals.js:46-48`), which runs every signal function in `signalFns` (`fraud/signals.js:44`) over that same context object and collects their results.
4. Each signal (`fraud/signals.js:9-42`) is a small, synchronous, pure function: `{ code, weight, triggered, detail }` in, given only plain data — no database calls, no `req`/`res`, nothing async — so every signal is unit-tested by calling it directly with a hand-built context. Six are implemented: `NEW_ACCOUNT` (account younger than 24 hours), `ORDER_VELOCITY` (more than 3 orders by this user in the last hour), `HIGH_VALUE` (order total above 200), `QUANTITY_ANOMALY` (any line quantity above 10), `EMAIL_MISMATCH` (checkout email differs from the account email, using Task 3's `normalizeEmail` so alias tricks don't create false mismatches), and `BLOCKED_DOMAIN` (checkout email's domain is on the Task 3 blocklist).
5. `services/orders.js:31` passes the six signal results to `score()` (`fraud/score.js:3-9`), which sums the `weight` of every `triggered` signal into a single number, collects the `code` of every triggered signal into `reasons`, and maps the total onto one of three decisions using the single exported `THRESHOLDS` constant (`fraud/score.js:1`): below 30 is `allow`, 30 up to (not including) 70 is `review`, 70 and above is `deny`.
6. `services/orders.js:32-33` acts on the decision: `deny` throws `ForbiddenError('order could not be completed')` before an `Order` document is created or the cart is touched; `allow` and `review` both create the order (with `status` set to `'review'` or left as the schema's default `'pending'`) and both go on to empty the cart, exactly like an order does today when there is no fraud check at all.
7. Every created order stores its full `fraud: { score, decision, reasons }` (`models/order.js:22-26`), but `orderSchema`'s `toJSON` transform (`models/order.js:31-37`) deletes `fraud` before the document is ever serialized into an HTTP response — the client only ever sees `status`, never the score or the reason codes behind it.

## The core concepts

- **Rules engine vs machine learning**: a rules engine (this file) is a fixed set of human-written conditions and weights — every decision is explainable by reading the code, and it ships on day one with zero training data. A machine-learning model can catch subtler, higher-dimensional patterns a human wouldn't think to write down, but needs a large labeled history of confirmed fraud/not-fraud outcomes to train on, and its individual decisions are harder to explain to a customer or a regulator. Both regulated systems (which must be able to justify a denial) and brand-new systems (which have no fraud history yet to train on) typically start with rules, and layer ML on top once there's enough labeled data.
- **Explainability and reason codes**: `reasons` (an array of signal codes like `HIGH_VALUE`) is what makes the score defensible — an analyst, a support agent, or a regulator can be told exactly which conditions fired, not just a number.
- **Three-way outcome instead of binary**: `allow`/`deny` alone forces every uncertain case into a guess. `review` is the load-bearing middle state — it defers genuinely ambiguous orders to a human instead of forcing the system to be right on the first try.
- **Thresholds as configuration, not code**: `THRESHOLDS` (`fraud/score.js:1`) is one exported constant precisely so tuning the boundary between `allow`/`review`/`deny` is a one-line, reviewable change, not a scattered edit across the codebase.
- **False positives cost more than they look**: every `review` or `deny` on a legitimate customer is a lost sale and, if it happens often, a customer who leaves for good — the true cost of a threshold set too aggressively is invisible in the fraud-loss numbers and only shows up in conversion and churn.
- **Review queues and human-in-the-loop**: a `review` order is not resolved by this code; it is meant to sit in a queue an operator works, who then confirms or overturns the decision — this repo creates the order with `status: 'review'` but implements no queue or operator action on it.
- **Feedback loops and labelling chargebacks**: a mature fraud system feeds confirmed chargebacks and confirmed-legitimate reviews back into retuning the weights (or training the model); without that loop, thresholds calibrated once slowly drift out of sync with how attackers actually behave.
- **Why the score never reaches the client**: returning the score (or the reason codes) hands an attacker a free oracle to probe against — vary one field at a time, watch the score/decision change, and reverse-engineer which signals matter and by how much. Keeping it server-side-only removes that feedback channel.
- **Velocity checks and what state they need**: `ORDER_VELOCITY` needs a rolling count of an account's own recent orders (`repositories/orderStats.js`), which only exists because `Order` already records `createdAt` per order — a velocity signal is only as good as the event history it can query.
- **Idempotency and replay**: this endpoint has no idempotency key, so retrying the exact same checkout request creates a second order and, notably, pushes the account's own `ORDER_VELOCITY` count up on each retry — a client-side retry-on-timeout can inadvertently manufacture the very signal that gets a legitimate customer's next order held for review.
- **Adversarial adaptation**: a fixed rules engine is a fixed target — once an attacker learns the thresholds (by probing, by leaked documentation, or simply by trial and error), they optimize around them (e.g. splitting one large order into several just under the `HIGH_VALUE` threshold). Rules need periodic revision for exactly this reason; a scoring system with no history of updates is one attackers have long since mapped out.

## Standard practice

- Keep every signal a pure function of explicit inputs — it is unit-testable in isolation, and two engineers reading the code can agree on what it does without reading the whole checkout flow.
- Store the full decision (score, decision, reasons) on the record it was computed for — an order whose fraud reasoning wasn't persisted cannot be explained or audited later.
- Never return the score or reasons in the client-visible API response — see "why the score never reaches the client" above.
- Put the numeric thresholds in one named, exported place — scattering `30` and `70` as inline literals across the codebase makes them impossible to tune safely.
- Route everything between `allow` and `deny` to a human review queue rather than picking a side — the whole point of a middle band is admitting the rules alone can't be trusted to call it either way.
- Reuse existing identity signals (this file reuses Task 3's blocklist and email normalization) rather than re-implementing detection logic per feature — a second, slightly different definition of "is this email suspicious" is a second place for the two definitions to drift and disagree.
- Re-tune thresholds and signal weights on a real, regularly reviewed cadence driven by chargeback and false-positive data, not once at launch and never again.

## What this toy skips

- No review queue or operator UI — a `review` order is created and then nothing in this codebase ever looks at it again.
- No feedback loop: nothing here records which `review` orders were later confirmed as fraud or confirmed as legitimate, so the weights in `fraud/signals.js` can never be data-driven; they were chosen by hand to produce sane behavior against this repo's own test fixtures.
- No idempotency key on order placement, so naive client retries inflate `ORDER_VELOCITY` for legitimate customers (see "idempotency and replay" above).
- No IP, device, or payment-instrument signals (new device, mismatched billing/shipping geography, card BIN country, proxy/VPN detection) — this demo only has six of many signals a production system would run.
- No per-customer or per-merchant-segment threshold overrides — `THRESHOLDS` is global.
- No machine-learning layer at all, and no historical data pipeline to eventually train one.
- No monitoring or alerting on how often each signal fires, which in production is how you notice a rule has gone stale or an attacker has started routing around it.

## Try it

With the dev server running and seed data loaded, place a small, unremarkable order — it should be created immediately with `status: "pending"` and no `fraud` field in the response:

```bash
curl -i -X POST http://localhost:5000/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"cartId":"cart-1","userId":"<a real user id>","customer":{"name":"Ada","email":"demo@shop.test","address":"1 Main Street"}}'
```

Add several high-quantity, high-value items to the same cart first, then place the order again from a freshly seeded (brand-new) account — the response should come back `201` with `status: "review"` instead of `"pending"`, still with no `fraud` field visible. Placing four or more orders for the same account within an hour, then a fifth large one, should push the combined score over the deny threshold and return `403 { "error": "order could not be completed" }` with the cart left untouched — check with:

```bash
curl -s http://localhost:5000/api/cart/cart-1
```
