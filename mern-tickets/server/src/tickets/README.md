# Ticketing core

## What this is

A support-ticket domain: tickets move through a fixed lifecycle, every mutation is written to an append-only audit log, and due dates are derived automatically from priority. This is the foundation the other four features (authorization, keyword blocking, throttling, and the hook pipeline) wire into.

## How it works here

`POST /api/tickets` (`src/routes/tickets.js:8`) calls `tickets.create` (`src/services/tickets.js:33`), which looks up the reporter, stamps `status: 'open'`, computes `dueAt` from priority via `dueAtFor` (`src/services/tickets.js:21`), and writes a `created` `TicketEvent` (`src/services/tickets.js:52`).

`PATCH /api/tickets/:id/status` (`src/routes/tickets.js:11`) calls `transitionStatus` (`src/services/tickets.js:76`), which looks up the ticket's current status, consults the `TRANSITIONS` map (`src/services/tickets.js:11`) for the allowed next states, rejects with 400 `invalid status transition` if `status` is not in that list, otherwise saves the new status and writes a `status_changed` event with `from`/`to`.

`PATCH /api/tickets/:id/assignee` and `POST /api/tickets/:id/comments` follow the same shape: load the ticket, perform the mutation, append a `TicketEvent` (`assignee_changed`, `commented`).

In every one of those cases the mutation and the event are two separate writes to two separate collections, with nothing tying them together (`src/services/tickets.js:83-84`, `:96-97`, `:52`, `:114`). MongoDB guarantees atomicity for a single document; it does not give you atomicity across two documents in two collections without an explicit multi-document transaction. A crash between the two writes therefore leaves a mutated ticket with no event recording the mutation — the exact hole the "Standard practice" section is warning about. See "What this toy skips."

`GET /api/tickets/:id` (`src/routes/tickets.js:10`, `src/services/tickets.js:66`) returns the ticket alongside its full comment list and its full event list in one response, so a client can render a timeline without three round trips. Every response that carries a ticket or comment goes through `viewModeratable` (`src/controllers/tickets.js:7`) first — see [`../moderation/README.md`](../moderation/README.md) for why.

Every route under `/api/tickets` runs through `identify` (`src/middleware/identify.js`), which reads the `x-user-id` header, loads that user, and attaches `{ id, role, teamId }` to `req.subject`. **This is not authentication.** There is no password check, no token, no session — anyone can put any user's id in that header and become them. It exists only so the rest of the request has a caller to reason about. Real login (`POST /api/auth/login`, `src/services/auth.js`) checks a bcrypt hash the same way `mern-shop/server/src/services/auth.js` does, but its result (a user object) is not turned into a credential the ticket routes verify. Authorization ([`../policy/README.md`](../policy/README.md)) is built on top of this identity; nothing here adds authentication on top of it — that would require sessions or tokens, out of scope for this app.

## The core concepts

- **State machine**: the ticket's `status` field only ever moves along edges listed in one exported map (`TRANSITIONS`), never through scattered `if (status === ...)` checks. The map is the single source of truth for what is legal. Note what the graph actually says: `open → triaged → in_progress → resolved`, and from `resolved` either `closed` or back to `open` (a reopen), with `closed` the only state that has no outgoing edges. Be precise about where enforcement lives — the schema's `enum` (`src/models/ticket.js:7`) constrains the *set of states* a ticket may be in, but it says nothing about *edges*; only `transitionStatus` enforces the graph. A direct `Ticket.updateOne({ status: 'closed' })` from anywhere else would pass validation and jump the ticket straight from `open` to `closed`.
- **Audit log — which is not event sourcing.** These are routinely conflated and they are different systems. In event sourcing, as Fowler defines it, every change to application state is captured as an event and the events are the system of record: you can throw the current state away entirely and rebuild it by replaying the log onto an empty application. That is not what `TicketEvent` is. Here the `Ticket` document is the system of record and events are a derived side-record of `{ actor, type, from, to, at }` written alongside it. They are not sufficient to rebuild a ticket: a `created` event stores `to: 'open'` and nothing about the title, body, priority, team or due date; a `commented` event stores `from: null, to: null` and not the comment. Replaying this log onto an empty database reconstructs nothing. That is a perfectly good audit log and a perfectly reasonable choice — the mistake is only ever in the naming, and the naming matters because event sourcing brings consequences (schema evolution of events, snapshots, projections, replay tooling) that an audit log does not.
- **Append-only, and by what mechanism.** Nothing updates or deletes a `TicketEvent` — but that is enforced by the shape of the repository, not by the database. `src/repositories/ticketEvents.js` exposes exactly `create`, `findByTicket` and `deleteAll`; there is no update path to call. The model itself is an ordinary Mongoose collection, so a direct `TicketEvent.updateOne` would work fine, and `deleteAll` exists and is used for test teardown. Real append-only storage means write-once media, a tamper-evident chain, or database permissions that do not include update — not a convention among the functions you happened to export.
- **SLA clock**: `dueAt` is a deadline computed once, at creation, from priority (urgent 4h, high 24h, normal 72h, low 168h). It does not move as the ticket changes state. It is also never read: no code sorts by it, escalates on it, or notices when it passes. Only the tests assert on it. A due date nothing acts on is a timestamp, not an SLA.
- **Queue vs assignment**: `assignee` is a single user reference; there is no notion of a shared queue here, just direct assignment.
- **Soft transition vs hard delete**: tickets are never deleted, only moved to a terminal `closed` state. The domain has no delete endpoint at all — and the policy set goes further, with an explicit deny rule that would block `ticket:delete` even for an admin if the endpoint existed (see [`../policy/README.md`](../policy/README.md)).

## Standard practice

- Keep the transition map as data, not `if` statements — a state machine that lives in one object is auditable and testable as a truth table; scattered conditionals are not.
- Write the state change and its audit event in the *same transaction*, not merely the same request. "Same request" is not enough: two sequential writes in one request still have a window between them, and a process that dies in that window leaves an audit log that quietly disagrees with reality. If the store cannot do multi-document transactions, put the event in the same document as the state, or use a transactional outbox (see [`../hooks/README.md`](../hooks/README.md)).
- Never write the audit event from a background job fired after the response — an audit log with eventual consistency and no delivery guarantee is not an audit log.
- Compute `dueAt` once, from priority, at creation — deriving it from "now" at read time would silently change past commitments every time it's viewed.
- Never let a controller touch a model directly — every mutation goes through the service so the event-writing and validation cannot be bypassed by a new route.
- Model `status` as an enum at the schema level in addition to the service-level state machine — belt and suspenders against a stray direct `Ticket.updateOne`. Understand what each layer buys: the enum rules out nonsense values, the service rules out illegal moves between sensible ones.
- Store the actor on every event, not just the change. `from`/`to` tells you what happened; `actor` is what makes the log answer the question anyone actually asks it.

## What this toy skips

- Real authentication (sessions, tokens, password-protected routes) — the `x-user-id` header is a stand-in, not a security boundary.
- Atomicity between a mutation and its audit event. Both writes are unconditional and sequential with no transaction around them, so a crash in between loses the event. The fixes available in MongoDB are a multi-document transaction (which requires a replica set or sharded cluster — a standalone `mongod` cannot start one) or restructuring so the event lands in the same document as the state.
- Tamper-evidence on the audit log — no hash chain, no write-once storage, no separate database permissions. Append-only here is a property of the repository's exported functions.
- Anything that reads `dueAt` — no breach detection, no escalation, no "overdue" filter, no notification.
- Business-hours-aware SLA clocks — `dueAt` is a flat wall-clock offset, not "4 business hours," so it can land on a weekend. There is also no stop-the-clock while waiting on the reporter, which is the feature real ticketing systems are asked for first.
- Ticket reassignment queues, round robin, or load-based routing — assignment is a direct, single write.
- Pagination on `GET /api/tickets` — it returns every match. `GET /api/tickets/:id` likewise returns every comment and every event with no limit, which is fine for five seeded tickets and not fine for a two-year-old ticket.
- Editing or deleting a comment once posted.

## Try it

```
curl -s -X POST http://localhost:5001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"rae@tickets.test","password":"demo1234"}'

curl -s -X POST http://localhost:5001/api/tickets \
  -H 'Content-Type: application/json' \
  -H 'x-user-id: <rae user id from login response>' \
  -d '{"title":"Cannot log in","body":"The password reset link is broken.","priority":"urgent"}'

curl -s 'http://localhost:5001/api/tickets?status=open' \
  -H 'x-user-id: <rae user id>'
```

Two details in there are deliberate. The quotes around the third URL are load-bearing in zsh, which treats the bare `?` as a glob and fails with `no matches found` before curl ever runs. And the body is *not* the seed's exact wording: `npm run seed` gives rae a ticket whose body is `Password reset link is broken.`, so posting that string verbatim within a minute of seeding gets you 400 `duplicate submission` from the hook pipeline rather than a new ticket (see [`../hooks/README.md`](../hooks/README.md)).

Two things in that second response are worth a second look, and both are documented elsewhere rather than being bugs in this module. `dueAt` is four hours out because the priority is `urgent`. And `moderation` comes back `{"flagged":true}` for a sentence containing nothing objectionable — the seeded substring term `ass` normalizes to `as`, `password` normalizes to `pasword`, and they match. See [`../moderation/README.md`](../moderation/README.md). The seeded copy of the same sentence is *not* flagged, because `seed.js` writes tickets straight through the repository and never runs the hook pipeline.

To see the audit log this README is about, fetch the ticket by id and look at `events`:

```
curl -s http://localhost:5001/api/tickets/<ticket id> -H 'x-user-id: <rae user id>'
```

You get exactly one event, and it looks like this:

```json
{ "ticket": "...", "actor": "...", "type": "created", "from": null, "to": "open", "at": "..." }
```

Now compare it against the ticket beside it, which carries `title`, `body`, `priority`, `teamId`, `dueAt` and `moderation`. Everything in `events` is derived from the ticket; nothing in the ticket could be derived from `events`. That asymmetry is the whole difference between an audit log and an event-sourced system, and it is visible in a single response.

## Further reading

- [Martin Fowler, Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) — the definition to check any "we do event sourcing" claim against, including the complete-rebuild test that this app's `TicketEvent` log fails. The sections on external updates and on retroactive events are where the real cost of the pattern shows up.
- [Chris Richardson, Transactional outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html) — the standard answer to "write the entity and record the fact atomically without distributed transactions." Directly applicable to the two-write gap in `transitionStatus` and `assign`.
- [MongoDB Manual, Transactions](https://www.mongodb.com/docs/manual/core/transactions/) — what multi-document atomicity costs here: the deployment requirements (replica set or sharded cluster), and the manual's own advice that modelling data so a single document covers the change is usually better than reaching for a transaction.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) — which events belong in an audit trail, why it is kept separate from application logging, and the practical measures for integrity: tamper detection, and moving records to read-only storage as early as possible.
- [NIST SP 800-92, Guide to Computer Security Log Management](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-92.pdf) — the fuller institutional treatment of log retention, protection and review, and the document most compliance language traces back to. It is from 2006 and is still the published final version; a differently scoped revision, [SP 800-92r1 "Cybersecurity Log Management Planning Guide"](https://csrc.nist.gov/pubs/sp/800/92/r1/ipd), has been at initial public draft since October 2023, so check that page before describing either as current.
- David Harel, "Statecharts: A Visual Formalism for Complex Systems", *Science of Computer Programming* 8(3), 1987, 231-274, [doi:10.1016/0167-6423(87)90035-9](https://weizmann.elsevierpure.com/en/publications/statecharts-a-visual-formalism-for-complex-systems/) — where hierarchy, orthogonality and history come from, and the paper behind essentially every modern state-machine library. Read it when a flat map like `TRANSITIONS` stops being enough, which happens the first time you need "paused" to be a modifier rather than a state. The link goes to the institutional record with the abstract and DOI; the full text is behind the journal's paywall, so this one may need a library.
- [Stately, What are state machines and statecharts?](https://stately.ai/docs/state-machines-and-statecharts) — the freely readable modern introduction, and where to get the working vocabulary (states, events, transitions, final states) if the 1987 paper is not to hand.
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) — relevant here for the honest reason: `identify` is not authentication, and this cheat sheet is a good reminder of everything the `x-user-id` placeholder is standing in for.

Elsewhere in this repo, in the order they build on this module: [`../policy/README.md`](../policy/README.md) decides whether a caller may do any of the above; [`../throttle/README.md`](../throttle/README.md) limits how fast; [`../hooks/README.md`](../hooks/README.md) is the pipeline that runs between the throttle and the write; [`../moderation/README.md`](../moderation/README.md) is the handler that decides whether the body is saved at all. Outside this app, [`../../../../mern-shop/server/src/passwordReset/README.md`](../../../../mern-shop/server/src/passwordReset/README.md) is the closest thing here to a real credential flow, and [`../../../../mern-movies/server/src/notifications/README.md`](../../../../mern-movies/server/src/notifications/README.md) covers the fan-out-on-a-domain-event problem this app deliberately does not have.
