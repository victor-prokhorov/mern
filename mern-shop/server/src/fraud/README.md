# Fraud scoring

## What this is

A rules-based check, run at checkout, that looks at a handful of signals about the order and the account placing it, and decides whether to let the order through, hold it for a human to look at, or refuse it outright. It replaces a single opaque "is this fraud, yes or no" guess with an explainable, adjustable score.

## How it works here

1. Two gates run before the service is even entered: `requireAuth` (`routes/orders.js:8`) rejects an unauthenticated request, so the `userId` the scorer works from is the one a verified access token names rather than anything the client typed ([`../session/README.md`](../session/README.md)), and the `idempotency` middleware on the same line replays a stored response for a repeated key without re-scoring ([`../idempotency/README.md`](../idempotency/README.md)). Then `services/orders.js:11` (`place`) runs the existing checks — invalid user, the blocklist's account-identity gate (`services/orders.js:15`: `user.blockedAt` or the account's own email on the pattern blocklist), cart existence — before fraud scoring ever runs, so a hard identity block never reaches the scoring step at all. That gate deliberately does **not** look at the checkout-supplied `customer.email` — see [`../blocklist/README.md`](../blocklist/README.md) for why that value is this layer's job, not the blocklist's.
2. Once the order's `items` and `total` are computed, `services/orders.js:27-30` fetches the pieces of state the signals need but cannot compute themselves: `orderStats.countRecentOrders` (`repositories/orderStats.js:3-5`, a `countDocuments` query for this user's orders in the last hour) and, separately from the account-identity gate above, `blocks.isBlockedEmail(customer.email)` — the checkout-supplied email, checked here against the same pattern blocklist purely as a fraud signal input, not as a hard gate.
3. `services/orders.js:31` calls `evaluateSignals({ user, cart, customer, stats, now })` (`fraud/signals.js:46-49`), which computes `now` once (from the passed value, or `Date.now()` if none was passed) and runs every signal function in `signalFns` (`fraud/signals.js:44`) over that same context, so every signal sees an identical, fixed instant in time rather than each independently reading the clock.
4. Each signal (`fraud/signals.js:9-42`) is a small, synchronous, pure function: `{ code, weight, triggered, detail }` out, given only plain data — no database calls, no `req`/`res`, no internal clock reads, nothing async — so every signal is unit-tested by calling it directly with a hand-built context, and two calls with the same context always produce the same result. Six are implemented, with the thresholds and weights named in `fraud/signals.js:3-7`:

   | Code | Weight | Fires when |
   | --- | --- | --- |
   | `NEW_ACCOUNT` | 20 | `user.createdAt` is less than 24 hours before the injected `now` |
   | `ORDER_VELOCITY` | 30 | more than 3 orders by this user in the last hour |
   | `HIGH_VALUE` | 20 | order total above 200 |
   | `QUANTITY_ANOMALY` | 25 | any single line quantity above 10 |
   | `EMAIL_MISMATCH` | 5 | checkout email differs from the account email after `normalizeEmail` |
   | `BLOCKED_RECIPIENT` | 100 | the checkout recipient's email is on the blocklist — the check is `isBlockedEmail(customer.email)`, so a matching `email`-type entry triggers it just as a `domain`-type one does. This signal used to be called `BLOCKED_DOMAIN`, a name narrower than its own input; `RECIPIENT` names what is actually being checked |

   `EMAIL_MISMATCH` reuses the blocklist's `normalizeEmail` so alias tricks don't create false mismatches. Because the account-identity gate above no longer inspects `customer.email`, `BLOCKED_RECIPIENT` is a live, reachable signal: a checkout email on a blocked domain is not rejected before scoring runs, it is scored, and its weight — 100, on its own already past the deny threshold — is what refuses the order. Note what that weight really means: a signal weighted above the deny threshold is a hard gate wearing a score's clothing. It is worth being deliberate about whether you want that, because it makes the score non-compensatory for that one signal: no combination of reassuring evidence can outvote it.
5. `services/orders.js:32` passes the six signal results to `score()` (`fraud/score.js:3-9`), which sums the `weight` of every `triggered` signal into a single number, collects the `code` of every triggered signal into `reasons`, and maps the total onto one of three decisions using the single exported `THRESHOLDS` constant (`fraud/score.js:1`): below 30 is `allow`, 30 up to (not including) 70 is `review`, 70 and above is `deny`.
6. `services/orders.js:33-34` acts on the decision: `deny` throws `ForbiddenError('order could not be completed')` before an `Order` document is created or the cart is touched; `allow` and `review` both create the order (with `status` set to `'review'` or left as the schema's default `'pending'`) and both go on to empty the cart, exactly like an order does today when there is no fraud check at all.
7. Every created order stores its full `fraud: { score, decision, reasons }` (`models/order.js:22-26`), but `orderSchema`'s `toJSON` transform (`models/order.js:31-37`) deletes `fraud` before the document is ever serialized into an HTTP response — the client only ever sees `status`, never the score or the reason codes behind it.

## The core concepts

- **Rules engine vs machine learning**: a rules engine (this file) is a fixed set of human-written conditions and weights — every decision is explainable by reading the code, and it ships on day one with zero training data. A machine-learning model can catch subtler, higher-dimensional patterns a human wouldn't think to write down, but needs a large labeled history of confirmed fraud/not-fraud outcomes to train on, and its individual decisions are harder to explain to a customer or a regulator. Both regulated systems (which must be able to justify a denial) and brand-new systems (which have no fraud history yet to train on) typically start with rules, and layer ML on top once there's enough labeled data. The two do not replace each other even at maturity: Uber's fraud platform runs mined rules alongside models specifically because, in their words, "explainability is of paramount importance when it comes to fraud detection", and every generated rule goes past a human analyst before it reaches production.
- **Explainability and reason codes**: `reasons` (an array of signal codes like `HIGH_VALUE`) is what makes the score defensible — an analyst, a support agent, or a regulator can be told exactly which conditions fired, not just a number. This is not only good practice; in adjacent domains it is law. Under the US Equal Credit Opportunity Act's Regulation B (12 CFR §1002.9), a creditor taking adverse action must give "a statement of specific reasons", and the regulation explicitly rejects the two evasions people reach for first: saying the decision came from "the creditor's internal standards or policies", or that the applicant "failed to achieve a qualifying score". The CFPB closed the obvious loophole in Circular 2022-03: a creditor "cannot justify noncompliance... based on the mere fact that the technology it employs to evaluate applications is too complicated or opaque to understand", and "a creditor's lack of understanding of its own methods is therefore not a cognizable defense". An e-commerce fraud check is not a credit decision, so none of this binds this code — but it is the clearest existing statement of the standard an explanation has to meet, and it is why reason codes are worth building before anyone asks for them.
- **Three-way outcome instead of binary**: `allow`/`deny` alone forces every uncertain case into a guess. `review` is the load-bearing middle state — it defers genuinely ambiguous orders to a human instead of forcing the system to be right on the first try.
- **Thresholds as configuration, not code**: `THRESHOLDS` (`fraud/score.js:1`) is one exported constant precisely so tuning the boundary between `allow`/`review`/`deny` is a one-line, reviewable change, not a scattered edit across the codebase.
- **False positives cost more than they look**: every `review` or `deny` on a legitimate customer is a lost sale and, if it happens often, a customer who leaves for good — the true cost of a threshold set too aggressively is invisible in the fraud-loss numbers and only shows up in conversion and churn.
- **Review queues and human-in-the-loop**: a `review` order is not resolved by this code; it is meant to sit in a queue an operator works, who then confirms or overturns the decision — this repo creates the order with `status: 'review'` but implements no queue or operator action on it. A real queue is a product, not a list: Stripe's has assignment (so two reviewers don't work the same item), a timeline of who did what, the related-payments view that shows other orders sharing an email, IP or card, and a small fixed set of terminal actions. Its stated first principle is worth borrowing wholesale — "focus time on payments where human judgment can add valuable insight to the decision", because a queue that fills faster than humans can work it is the same as no queue at all.
- **Automated decision-making and the "right to explanation"**: this is more contested than it is usually presented. GDPR Article 22(1) gives a data subject the right not to be subject to a decision "based solely on automated processing" producing legal or similarly significant effects; Article 22(3) requires safeguards including "the right to obtain human intervention on the part of the controller, to express his or her point of view and to contest the decision". A right to *explanation* appears nowhere in Article 22's text — it lives in Recital 71, which is not binding, and in the access right at Article 15(1)(h), which entitles the subject to "meaningful information about the logic involved". The CJEU put substance behind that phrase in Case C-203/22 (*Dun & Bradstreet Austria*, 27 February 2025): the controller must describe the procedure and principles actually applied so the subject can understand which of their data was used and how, and it may be appropriate to explain "the extent to which a variation in the personal data taken into account would have led to a different result" — a counterfactual, not a formula. Trade secrecy is not an exit: the information must still go to the supervisory authority or court to balance. Separately, the EU AI Act (Regulation (EU) 2024/1689) classifies creditworthiness scoring as high-risk in Annex III(5)(b) but carves out, in the same clause, "AI systems used for the purpose of detecting financial fraud". So a fraud checker sits outside that particular obligation while a credit scorer does not — a distinction worth knowing before assuming either that the AI Act applies here or that it does not.
- **Feedback loops and labelling chargebacks**: a mature fraud system feeds confirmed chargebacks and confirmed-legitimate reviews back into retuning the weights (or training the model); without that loop, thresholds calibrated once slowly drift out of sync with how attackers actually behave.
- **Why the score never reaches the client**: returning the score (or the reason codes) hands an attacker a free oracle to probe against — vary one field at a time, watch the score/decision change, and reverse-engineer which signals matter and by how much. Keeping it server-side-only removes that feedback channel.
- **Velocity checks and what state they need**: `ORDER_VELOCITY` needs a rolling count of an account's own recent orders (`repositories/orderStats.js`), which only exists because `Order` already records `createdAt` per order — a velocity signal is only as good as the event history it can query.
- **Idempotency and replay**: `POST /api/orders` now supports an `Idempotency-Key` header ([`../idempotency/README.md`](../idempotency/README.md)), but only when the client sends one — the header is optional, and a request without it is handled exactly as before. So the interaction is worth stating precisely rather than assuming it away: a client that retries *without* a key creates a second order and pushes its own `ORDER_VELOCITY` count up on each retry, and a retry-on-timeout can therefore manufacture the very signal that gets that customer's next order held for review. A client that retries *with* the same key replays the stored response and never re-enters the scorer at all, so the velocity count is unmoved. This is the sharpest argument in this repo for making the key mandatory on a scored endpoint: the cost of a missing key is not just a duplicate order, it is a duplicate order that degrades the customer's own fraud score.
- **Adversarial adaptation**: a fixed rules engine is a fixed target — once an attacker learns the thresholds (by probing, by leaked documentation, or simply by trial and error), they optimize around them (e.g. splitting one large order into several just under the `HIGH_VALUE` threshold). Rules need periodic revision for exactly this reason; a scoring system with no history of updates is one attackers have long since mapped out.

## Standard practice

- Keep every signal a pure function of explicit inputs — it is unit-testable in isolation, and two engineers reading the code can agree on what it does without reading the whole checkout flow.
- Store the full decision (score, decision, reasons) on the record it was computed for — an order whose fraud reasoning wasn't persisted cannot be explained or audited later.
- Never return the score or reasons in the client-visible API response — see "why the score never reaches the client" above.
- Put the numeric thresholds in one named, exported place — scattering `30` and `70` as inline literals across the codebase makes them impossible to tune safely.
- Route everything between `allow` and `deny` to a human review queue rather than picking a side — the whole point of a middle band is admitting the rules alone can't be trusted to call it either way.
- Reuse existing identity signals (this file reuses the blocklist and its email normalization) rather than re-implementing detection logic per feature — a second, slightly different definition of "is this email suspicious" is a second place for the two definitions to drift and disagree. This app is not fully clean on its own advice: the rate limiter builds its email keys with a bare `.toLowerCase()` rather than `normalizeEmail`, which is the drift this bullet warns about, caught in the act.
- Give the human reviewer more than the score — the payment or order alone is rarely enough to call it. What makes a review queue work is the surrounding context: other orders sharing this email, IP or payment instrument; the account's history; whatever business-specific metadata makes the decision obvious to someone who knows the business. A queue that shows only a score and a total asks a human to guess with less information than the rules had.
- Re-tune thresholds and signal weights on a real, regularly reviewed cadence driven by chargeback and false-positive data, not once at launch and never again.
- Keep a signal weighted above the deny threshold honest about what it is — `BLOCKED_RECIPIENT` at 100 is a hard rule expressed as a weight. That is a legitimate choice, but it should be a deliberate one, because it means the "score" is not doing any work for that case and no accumulation of contrary evidence can change the outcome.

## What this toy skips

- No review queue or operator UI — a `review` order is created and then nothing in this codebase ever looks at it again. That is the single largest gap: the three-way outcome is the design's main idea, and the third outcome is unimplemented on the other side of the boundary.
- No context for a reviewer even if there were one: no related-orders view (other orders sharing this email, address or account), no account history surfaced alongside the decision. The `fraud.reasons` array is stored, but nothing renders it.
- No customer-facing consequence of the middle band — a `review` order looks identical to a `pending` one from the client's side, so there is no notification, no hold on fulfilment, and nothing telling the customer their order is delayed.
- No path for a customer to contest a decision or reach a human, which is the safeguard Article 22(3) GDPR names first for decisions that fall under it.
- No feedback loop: nothing here records which `review` orders were later confirmed as fraud or confirmed as legitimate, so the weights in `fraud/signals.js` can never be data-driven; they were chosen by hand to produce sane behavior against this repo's own test fixtures.
- Idempotency keys on order placement are optional, so a naive client that omits the header still inflates its own `ORDER_VELOCITY` on every retry (see "idempotency and replay" above). Nothing here makes the key mandatory on the endpoint the scorer guards.
- Nothing feeds a denied or reviewed order back into the signals as state: a customer whose order was just denied can retry immediately and be scored from scratch, since `deny` throws before an `Order` is written and `ORDER_VELOCITY` only counts written orders. A real system counts *attempts*, not just successes.
- No IP, device, or payment-instrument signals (new device, mismatched billing/shipping geography, card BIN country, proxy/VPN detection) — this demo only has six of many signals a production system would run.
- No per-customer or per-merchant-segment threshold overrides — `THRESHOLDS` is global.
- No machine-learning layer at all, and no historical data pipeline to eventually train one.
- No monitoring or alerting on how often each signal fires, which in production is how you notice a rule has gone stale or an attacker has started routing around it.

## Try it

With the dev server running (`JWT_SECRET=dev-secret npm run dev`) and seed data loaded, log in first — checkout is authenticated now, and the account the score is computed against is the one the access token names, never anything in the request body ([`../session/README.md`](../session/README.md)):

```bash
curl -s -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@shop.test","password":"demo1234"}'
```

Take the `accessToken` from that response and use it on every order below. Put something in a cart and place a small, unremarkable order — it should be created immediately with `status: "pending"` and no `fraud` field in the response:

```bash
curl -s -X POST http://localhost:5000/api/cart/cart-1/items \
  -H 'Content-Type: application/json' \
  -d '{"productId":"<the Ceramic Mug id>","qty":1}'

curl -i -X POST http://localhost:5000/api/orders \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <accessToken>' \
  -d '{"cartId":"cart-1","customer":{"name":"Ada","email":"demo@shop.test","address":"1 Main Street"}}'
```

A note on that first order: a freshly seeded account is minutes old, so `NEW_ACCOUNT` (20) already fires. The score is 20, below the review threshold of 30, so the decision is `allow` — you are not seeing a zero-signal order, you are seeing one signal that isn't enough on its own. That is the intended shape of a weighted score.

To reach `review`, make the cart worth scoring. Twenty units of a 12-unit item is a total of 240, which trips `HIGH_VALUE` (20) and `QUANTITY_ANOMALY` (25); with `NEW_ACCOUNT` (20) that is 65 — above 30, below 70:

```bash
curl -s -X POST http://localhost:5000/api/cart/cart-a/items \
  -H 'Content-Type: application/json' \
  -d '{"productId":"<the Ceramic Mug id>","qty":20}'

curl -s -X POST http://localhost:5000/api/orders \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <accessToken>' \
  -d '{"cartId":"cart-a","customer":{"name":"Ada","email":"demo@shop.test","address":"1 Main Street"}}'
```

The response is `201` with `"status":"review"` and, as always, no `fraud` field.

For `deny`, add velocity. `ORDER_VELOCITY` fires at *more than* 3 orders in the last hour, so it needs four already on record before the order being scored. The two orders above are the first two; place three more plain ones, then repeat the large order into a fresh cart: 30 + 20 + 20 + 25 = 95, past the deny threshold of 70:

```bash
export AT='<accessToken>'
for c in cart-b1 cart-b2 cart-b3; do
  curl -s -o /dev/null -X POST http://localhost:5000/api/cart/$c/items \
    -H 'Content-Type: application/json' -d '{"productId":"<the Ceramic Mug id>","qty":1}'
  curl -s -o /dev/null -X POST http://localhost:5000/api/orders \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $AT" \
    -d "{\"cartId\":\"$c\",\"customer\":{\"name\":\"Ada\",\"email\":\"demo@shop.test\",\"address\":\"1 Main Street\"}}"
done

curl -s -o /dev/null -X POST http://localhost:5000/api/cart/cart-c/items \
  -H 'Content-Type: application/json' -d '{"productId":"<the Ceramic Mug id>","qty":20}'

curl -s -X POST http://localhost:5000/api/orders \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $AT" \
  -d '{"cartId":"cart-c","customer":{"name":"Ada","email":"demo@shop.test","address":"1 Main Street"}}'
```

That last order returns `403 { "error": "order could not be completed" }`. Work the arithmetic out for your own case rather than trusting the recipe — on an account older than 24 hours `NEW_ACCOUNT` drops out and the same order scores 75, still a deny; drop `QUANTITY_ANOMALY` as well and it is 50, a review. The thresholds are three lines away in `fraud/score.js:1`.

Confirm the deny left `cart-c` alone, which is the property that makes a refusal safe to retry:

```bash
curl -s http://localhost:5000/api/cart/cart-c
```

The items are still there. An allowed or reviewed order empties the cart; a denied one does not, because `ForbiddenError` is thrown at `services/orders.js:33` before `orders.create` and the cart write at `services/orders.js:34-36`.

The fastest way to see `BLOCKED_RECIPIENT` alone carry an order past the deny threshold is to block a domain and check out with an address on it — that walkthrough is in [`../blocklist/README.md`](../blocklist/README.md), along with the subdomain that escapes it.

## Further reading

- [Uber: Project RADAR — Intelligent Early Fraud Detection with Humans in the Loop](https://www.uber.com/blog/project-radar-intelligent-early-fraud-detection/) — the best available account of running a rules engine at scale without pretending rules are obsolete. Rules are mined automatically, then reviewed and approved by a human analyst before deployment, because "even the small mistakes could lead to incorrect actioning on thousands of users".
- [Stripe Radar: transaction risk prevention](https://docs.stripe.com/radar/risk-evaluation) — a production three-way outcome with the numbers made public: a 0–99 score, elevated at 65, highest at 75, and a documented mapping from score to block/review/allow. Useful as a sanity check on whether your own thresholds are in a sane place.
- [Stripe Radar: reviews](https://docs.stripe.com/radar/reviews) — what the review queue this app does not have would actually contain: assignment, a timeline, related payments sharing an email or IP or card, and the honest warning that adding review to a flow with no natural fulfilment delay just slows down good customers.
- [12 CFR §1002.9 (Regulation B, Notifications)](https://www.consumerfinance.gov/rules-policy/regulations/1002/9/) — the legal floor for a reason code, and the source of the rule that "you failed to achieve a qualifying score" is not a reason. Read §1002.9(b)(2) and its official interpretation together.
- [CFPB Circular 2022-03: adverse action notices and complex algorithms](https://www.consumerfinance.gov/compliance/circulars/circular-2022-03-adverse-action-notification-requirements-in-connection-with-credit-decisions-based-on-complex-algorithms/) — four pages that dispose of "the model is a black box" as a defence. The line to remember is that a creditor's lack of understanding of its own methods is not a cognizable defence.
- [GDPR Article 22](https://gdpr-info.eu/art-22-gdpr/) and [Article 15(1)(h)](https://gdpr-info.eu/art-15-gdpr/) — read both, and notice that the safeguards in Article 22(3) are human intervention, expressing a point of view, and contesting the decision. The explanation right is in Article 15, not here, and the difference matters when someone tells you GDPR contains a "right to explanation".
- [CJEU Case C-203/22, *Dun & Bradstreet Austria* — Court press release, 27 February 2025](https://curia.europa.eu/site/upload/docs/application/pdf/2025-02/cp250022en.pdf) (two pages; the full judgment is on EUR-Lex under CELEX 62022CJ0203) — the judgment that turned "meaningful information about the logic involved" into something testable: describe the procedure and principles actually applied, and consider showing how a change in the input data would have changed the result. A counterfactual explanation, which is roughly what a list of triggered reason codes is.
- [EU AI Act, Annex III](https://artificialintelligenceact.eu/annex/3/) — point 5(b) makes creditworthiness scoring high-risk and, in the same sentence, excludes systems "used for the purpose of detecting financial fraud". Worth reading in the original before accepting anyone's summary of whether it applies to your system.
- [EMVCo: EMV 3-D Secure](https://www.emvco.com/emv-technologies/3-d-secure/) — the payments-industry version of the same three-way outcome, expressed as frictionless flow versus challenge flow. It is the standard answer to "what should we do with the middle band" when the middle band is a card payment and a human queue is too slow.
- [OWASP API Security Top 10 — API6:2023 Unrestricted Access to Sensitive Business Flows](https://owasp.org/API-Security/editions/2023/en/0xa6-unrestricted-access-to-sensitive-business-flows/) — the abuse class this scorer exists to catch: an endpoint that is individually well-formed and collectively exploitable. Its instruction to "identify the business flows that might harm the business if they are excessively used" is a better starting point for choosing signals than a list of red flags, and its point that the same flow is abuse at one company and growth at another is why weights cannot be copied between products.
- [`../blocklist/README.md`](../blocklist/README.md) — where the checkout email's `BLOCKED_RECIPIENT` input comes from, why the account gate deliberately ignores that value, and the layering argument for running identity checks before scoring.
- [`mern-tickets/server/src/moderation/README.md`](../../../../mern-tickets/server/src/moderation/README.md) — the same reject/flag-for-review/allow structure applied to text, including a fuller treatment of what happens to the flagged middle when nobody works the queue.
- [`mern-movies/server/src/recommendations/README.md`](../../../../mern-movies/server/src/recommendations/README.md) — a weighted scoring system with the opposite failure mode. Comparing the two is the quickest way to see how much the cost asymmetry between a false positive and a false negative should change the design.
