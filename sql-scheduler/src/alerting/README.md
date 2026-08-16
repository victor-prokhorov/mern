# Alerting

## What this is

The part of the app that notices when the schedule stops being met, and says
so exactly once per problem rather than every time it re-checks. Sending a
webhook is the easy 5% of this; the other 95% is the machinery that keeps
that webhook from becoming noise nobody reads: deduplication so a still-broken
condition doesn't spawn a new alert every evaluation, hysteresis so a value
oscillating around its threshold doesn't page on every wobble, and cooldown so
a genuinely still-firing problem doesn't renotify every few seconds forever.
`src/alerting/rules.js` is pure predicate logic (no database, unit-testable in
isolation); `src/alerting/lifecycle.js` is the stateful alert state machine
built on top of it; `src/alerting/delivery.js` is how a notification actually
leaves the process.

## How it works here

**Three rule kinds, each a pure function of already-queried metrics, not of
the database.** `evaluateMissedRun(rule, { overdueSeconds })`
(`src/alerting/rules.js:3-5`) breaches once a schedule's `next_run_at` is more
than `rule.threshold` seconds in the past. `evaluateRunFailureRate(rule,
{ failures, total })` (`src/alerting/rules.js:7-10`) breaches only when the
failure rate exceeds `rule.threshold` **and** `total` meets
`MIN_VOLUME_FOR_FAILURE_RATE` (5) — the same shape as this repo's circuit
breaker (`mern-tickets/server/src/circuitBreaker/README.md`): a rate alone
conflates "3 failures out of 5 calls" with "3 failures out of 5,000," and a
minimum-volume floor is what keeps a quiet, low-traffic schedule from tripping
on a single unlucky run. `evaluateSchedulingLag(rule, { lagSeconds })`
(`src/alerting/rules.js:12-14`) breaches when `started_at - occurrence_at`
exceeds the threshold — this is the one a naive "did it run" check cannot
see at all: a schedule can be executing every occurrence, `missed_run` sees
nothing wrong (there's always a run, so `overdueSeconds` never grows), while
every one of those runs starts minutes late. `test/alerting.test.js`'s
"the case a liveness check misses" test makes this concrete: identical
underlying metrics (`overdueSeconds: 0, lagSeconds: 300`) produce
`evaluateMissedRun → false` and `evaluateSchedulingLag → true` side by side —
proof the two rules are answering genuinely different questions, not the same
one phrased differently.

**Alert lifecycle, not events.** `alerts.state` is `pending → firing →
resolved`. `evaluate(pool, rule, subject, breached)`
(`src/alerting/lifecycle.js:108-119`) looks up any existing non-resolved alert
for `(rule.id, subject)` (`alertsRepo.findOpen`, filtering `state <> 'resolved'`)
before deciding anything. If a breach comes in and one already exists, that
row is **updated** — `occurrences` increments, `consecutive_breaches`
increments — never a second row inserted for the same rule and subject. That
update-not-insert behaviour is enforced two ways at once, matching the
scheduler's own lock/constraint pattern: the app checks `findOpen` first
(cheap, correct in the overwhelmingly common single-evaluator case), and the
database backs it with `alerts_one_open_idx`
(`src/migrations/007_alerts_widen_open_index.sql`), a unique index on
`(rule_id, subject) WHERE state <> 'resolved'`. The narrow window where two
evaluators can both see "no existing alert" and both attempt to create the
first one is closed with the same `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` pattern
the scheduler's `runsRepo.createGuarded` uses:
`alertsRepo.createGuarded` (`onFirstBreach`, `src/alerting/lifecycle.js:75-106`)
lets the loser roll back just its own failed insert, re-fetch the winner's
now-committed row, and fold into the normal `onBreach` update path instead of
throwing a `23505` out of `evaluate`. This was proven with a genuinely forced
race, not `Promise.all` of two independent `evaluate()` calls — that version
passed with no fix at all, because a fast local Postgres often finishes the
first transaction's `findOpen`-then-insert before the second transaction's
own `findOpen` even runs, which would have been a vacuous test. The real
test (`test/evaluator.test.js`) opens two raw pool clients, has one `BEGIN`
and insert without committing, starts the second's guarded insert (which
blocks on the first), commits the first, and only then awaits the second —
forcing the actual conflict deterministically and asserting the loser
resolves to `null` rather than rejecting.

**Hysteresis, in both directions.** A rule's `for_evaluations` is how many
*consecutive* breaches are required before an alert actually starts `firing`
(and notifies) — below that count it sits in `pending`, invisible to anyone
downstream, tracked only so the count can accumulate. Critically, a single
clear resets the streak: `onClear` (`src/alerting/lifecycle.js:51-73`)
deletes a `pending` alert outright the moment a clear arrives, so a condition
that breaches twice, clears once, then breaches twice more has to reach
`for_evaluations` fresh — it never "banks" partial progress across a clear.
The same count gates recovery: a `firing` alert needs `for_evaluations`
*consecutive* clears before it transitions to `resolved` and fires exactly
one resolution notification; a single breach in the middle of a recovery
resets `consecutive_clears` back to zero and the alert stays `firing`. Both
directions are tested against real sequences of `evaluate` calls (not
inferred from a single call), and — because "on the first breach" and "only
after breaching enough" look identical unless a test actually flaps the
condition — the flapping test's original assertions were wrong on the first
run (expecting the alert to fire after two post-clear breaches instead of
three), and rerunning against the real implementation is what caught that the
test's *expectations*, not the code, needed fixing: proof the test was
actually checking the hysteresis count rather than passing by coincidence.

**Cooldown and renotification.** A `firing` alert renotifies only if
`now - last_notified_at >= cooldown_seconds` (`src/alerting/lifecycle.js:39`);
otherwise the alert's counters still update (so `occurrences` stays accurate)
but no notification row is created. Forcing this check to always pass while
building the feature turned "cooldown suppresses renotification" red
immediately (a second notification appeared where the test expected `null`),
and a separate test confirms the opposite — waiting past the cooldown window
produces a second, real notification — so the mechanism is proven in both the
suppressing and the allowing direction, not just one.

**Delivery.** `deliverWithRetry` (`src/alerting/delivery.js:23-49`) POSTs a
notification's payload with `fetch` under `AbortSignal.timeout` (so a hung
webhook can't hold a delivery attempt open forever — see the circuit
breaker's README for why an unbounded call is the one failure mode nothing
else here can recover from), retries on failure with
`fullJitterBackoffMs(attempt, baseMs, capMs)` — `Math.random() *
min(capMs, baseMs * 2^attempt)`, the AWS "full jitter" formula, chosen over
plain exponential backoff specifically because *synchronized* retries (every
failed delivery backing off by the identical schedule) recreate the exact
thundering-herd problem backoff exists to avoid — and marks the notification
`parked` after the configured attempt count is exhausted, recording the last
error. Tested against a real local `node:http` server (not a mocked `fetch`)
that returns `500` on every request: three attempts are made, all three
requests actually land on the test server, and the notification ends up
`parked` with `attempts: 3` — and a second test against a healthy server on
the same pattern confirms the success path marks `delivered`.

**The evaluator wires the rest together, and guards itself the same way the
scheduler guards its tick.** `evaluateAllRules(pool)`
(`src/alerting/evaluator.js`) walks every active rule against every schedule,
isolating each `(rule, schedule)` pair in its own `try`/`catch` for the same
reason the scheduler isolates each due schedule — one rule's metrics query
blowing up shouldn't stop the rest of the sweep from evaluating. Whenever an
`evaluate()` call actually produces a notification, `evaluateOne` calls
`deliverWithRetry(pool, notification, { url: rule.channel, ... })` right
after, once the alert's own transaction has already committed — delivery is
a real network call, and holding a database transaction open across one
would be exactly the kind of thing a timeout section warns against
elsewhere in this repo. `evaluateRulesTick(pool)` wraps the whole sweep in
`pg_try_advisory_lock` under a key distinct from the scheduler's tick lock,
mirroring `tick()`'s own liveness guard — `src/index.js` calls
`evaluateRulesTick`, never the raw `evaluateAllRules`, exactly as `index.js`
calls `tick()` and never `runDueSchedules` directly. Before this wiring
existed, a firing alert's notification sat at `state: 'pending', attempts: 0`
forever — created, never delivered, never retried — which is a real
regression a previous pass introduced and this one closes.

## The core concepts

- **Retry belongs here; a second job queue does not.** `deliverWithRetry`'s
  loop is a small, local, single-purpose retry — bounded attempts, backoff,
  one terminal `parked` state — built because this app is allowed exactly
  this much delivery machinery for its own webhook calls. It is deliberately
  *not* a general-purpose reliable-execution system: no lease, no reaper
  reclaiming a delivery some dead process abandoned mid-attempt, no fairness
  across notifications, no separate dead-letter table. If any of that ever
  became necessary — many channels, delivery volume worth sharding, a need
  to inspect and manually replay parked notifications at scale — that is
  exactly the `sql-jobs` app's problem to own, not a reason to grow a second
  queue inside this one.
- **The trap: an alerting system that depends on what it's watching.** If
  the alert evaluator itself runs as a scheduled job inside the same
  process, on the same database, using the same tick mechanism as everything
  it's supposed to be watching, then the exact failure this system exists to
  catch — the scheduler stopped running — is also the failure that stops the
  alert about it from ever firing. An alerting system that shares its own
  fate with its dependency goes silent exactly when it's needed most, and
  silently is the worst way to fail: no alert firing looks identical, from
  the outside, to "everything is fine." The fix is not "make this app's
  evaluator more reliable" — that only pushes the same trap one level down
  (what watches the watcher?). The fix is a **dead man's switch**: an
  external, independent process that expects a heartbeat on a schedule and
  pages when the heartbeat itself goes missing, inverting the failure
  direction from "absence of a signal means nothing happened" to "absence
  of a signal is itself the alert." This is deliberately kept out of this
  app's code — a dead man's switch that lived inside the same process it
  was watching would just be the trap again, one layer deeper. In a real
  deployment this would be an external service (a third-party
  heartbeat/dead-man-switch product, or a completely separate always-on
  health-check process on different infrastructure) that this app's
  evaluator pings on success; missing pings, not application logic, are
  what escalate. The **out-of-band path** is the same idea generalised: at
  least one notification channel for the alert-that-the-alerter-is-down
  should not depend on anything this app owns — not the same database, not
  the same process, ideally not even the same cloud provider region —
  because every shared dependency is a way for "the alerter is down" and
  "the alerter can't tell anyone it's down" to have the same root cause.
- **Symptoms versus causes, and why you alert on symptoms.** `scheduling_lag`
  alerts on "runs are late" (a symptom users would feel), not on "the
  database connection pool is at 80%" (a cause, which might or might not
  ever produce a symptom). Alerting on causes produces alerts nobody can
  connect to actual impact and trains people to ignore them; alerting on
  symptoms means every alert that fires corresponds to something actually
  going wrong for someone.
- **Alert fatigue as the primary failure mode of monitoring, not a secondary
  inconvenience.** A system that pages correctly but too often trains its
  on-call to stop reading pages carefully, at which point it has the same
  practical reliability as a system with no alerting at all — worse, in fact,
  since it creates the appearance of coverage. Every mechanism in this
  module (dedup, hysteresis, cooldown, minimum volume) exists to cut the
  false-positive and repeat-positive rate, because the true-positive rate was
  never the hard part.
- **Deduplication, grouping, inhibition, silences** — the standard vocabulary
  (Prometheus Alertmanager uses all four terms directly). This module
  implements deduplication (one alert per rule+subject, updated not
  recreated) directly. Grouping (bundling several related alerts into one
  notification) and inhibition (suppressing a downstream alert because a
  known upstream cause is already firing — e.g. don't page for
  `scheduling_lag` on every schedule if the whole database is unreachable)
  are not implemented here; a real deployment at any scale needs both, and
  Alertmanager is the reference for how.
- **Hysteresis and flapping**, covered above in "How it works here" —
  `for_evaluations` is this module's version of the same idea a thermostat
  uses to avoid clicking on and off across a threshold reached exactly at the
  setpoint.
- **What makes an alert actionable.** An alert with no clear next step trains
  people to dismiss it, the same way a log line with no `requestId` trains
  people to skip correlating it — see
  [`../../../mern-tickets/server/src/observability/README.md`](../../../mern-tickets/server/src/observability/README.md)
  for the same principle applied to logs. This module's `payload`
  (`buildPayload`, `src/alerting/lifecycle.js:6-8`) carries the rule kind,
  the subject, the current state, and the occurrence count — enough for a
  human to know *what* is wrong and *how long* it's been wrong, which is the
  minimum a page needs to be actionable rather than merely noisy.
- **SLOs and burn-rate alerting**, what this becomes at scale. Rather than a
  fixed threshold per rule, a mature version of `scheduling_lag` would be
  framed as an SLO ("99% of occurrences start within 60s of their scheduled
  time over a rolling 30 days") and alert on *burn rate* — how fast the
  error budget is being consumed — so a brief, survivable blip and a sustained
  degradation page differently, and with different urgency. This app's fixed
  thresholds are the simpler, more legible starting point that burn-rate
  alerting is the answer to once thresholds alone start producing the wrong
  urgency too often.
- **On-call ergonomics.** An alert nobody can act on trains people to ignore
  the ones they can — the single most important sentence in this file. Every
  mechanism above is in service of that one fact.

## Standard practice

- Alert on symptoms, not on every cause that might produce one.
- Deduplicate at the source (one alert record per condition, updated in
  place) rather than downstream in a notification tool.
- Require sustained breach (hysteresis) before firing, and sustained
  recovery before resolving — a single sample crossing a threshold is not
  evidence of a trend.
- Cool down renotification for a still-firing condition; renotify once the
  cooldown elapses so a long-lived incident is not silently forgotten either.
- Require a minimum sample volume before trusting a rate — see the circuit
  breaker's README for the fuller argument.
- Give an alert-about-the-alerter an independent, out-of-band path — a dead
  man's switch that shares no infrastructure with what it's watching.

## What this toy skips

- Grouping and inhibition (see "The core concepts" above) — every alert here
  notifies independently, with no bundling of related alerts or suppression
  of a downstream one when a known upstream cause is already firing.
- A configurable minimum-volume threshold per rule — `MIN_VOLUME_FOR_FAILURE_RATE`
  is a fixed constant (`src/alerting/rules.js:1`), not a column on
  `alert_rules`, because this app's `run_failure_rate` is the only rule kind
  that needs one.
- Burn-rate / SLO-based alerting — thresholds here are fixed, not
  budget-relative.
- An actual dead man's switch or external heartbeat process — deliberately
  out of this app's code, per "The trap" above; this repo describes the
  pattern and why it must live outside the thing it watches, but does not
  ship the external watcher itself.
- Multiple notification channels beyond a single webhook per rule, and any
  channel-specific formatting (Slack blocks, PagerDuty's event schema, etc).

## Try it

Point a rule's channel at a local upstream you control, the same two-route
pattern the circuit breaker's README uses:

```js
import http from 'node:http'
let fail = true
http.createServer((req, res) => {
  if (req.url === '/heal') { fail = false; res.writeHead(200); res.end('ok'); return }
  res.writeHead(fail ? 500 : 200)
  res.end()
}).listen(4700, '127.0.0.1', () => console.log('fake webhook on 4700'))
```

Then, against the seeded deliberately-failing schedule (`npm run seed`),
watch an alert progress from `pending` to `firing` to `resolved` as its
`run_failure_rate` rule evaluates across ticks:

```bash
psql "$DATABASE_URL" -c "select id, rule_id, subject, state, occurrences, consecutive_breaches, consecutive_clears from alerts order by opened_at desc;"
psql "$DATABASE_URL" -c "select id, channel, state, attempts, last_error from notifications order by id desc;"
```

## Further reading

- [Google, *Site Reliability Engineering*: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) —
  symptoms vs. causes, and the four golden signals this module's three rule
  kinds are a small slice of.
- [Google, *Site Reliability Engineering*: Practical Alerting from
  Time-Series Data](https://sre.google/sre-book/practical-alerting/) — the
  chapter burn-rate alerting comes from, and the fuller case for why fixed
  thresholds stop working at scale.
- [Prometheus Alertmanager docs, Grouping, Inhibition, Silences](https://prometheus.io/docs/alerting/latest/alertmanager/) —
  the standard vocabulary this README borrows, and the reference
  implementation of the two mechanisms this module deliberately skips.
- [AWS Builders' Library, Timeouts, retries, and backoff with jitter (Marc Brooker)](https://d1.awsstatic.com/builderslibrary/pdfs/timeouts-retries-and-backoff-with-jitter.pdf) —
  the source of the full-jitter formula `fullJitterBackoffMs` implements, and
  why synchronized backoff recreates the herd problem it's meant to solve.
- [Wikipedia, Dead man's switch](https://en.wikipedia.org/wiki/Dead_man%27s_switch) —
  the general mechanism; healthchecks.io and similar third-party services are
  the practical, off-the-shelf version of "an external process that pages
  when a heartbeat stops."

Elsewhere in this repo:
[`../../../mern-tickets/server/src/circuitBreaker/README.md`](../../../mern-tickets/server/src/circuitBreaker/README.md)
for the minimum-volume argument `run_failure_rate` reuses directly, and for
timeouts as a precondition this module's `AbortSignal.timeout` also leans on;
[`../../../mern-tickets/server/src/observability/README.md`](../../../mern-tickets/server/src/observability/README.md)
for what makes a log line (and, by the same argument, an alert) actionable;
[`../scheduler/README.md`](../scheduler/README.md) for `occurrence_at` versus
`started_at`, the distinction `scheduling_lag` is built on.
