# Ticketing core

## What this is

A support-ticket domain: tickets move through a fixed lifecycle, every mutation is written to an append-only audit log, and due dates are derived automatically from priority. This is the foundation the other three features (authorization, keyword blocking, throttling) wire into.

## How it works here

`POST /api/tickets` (`src/routes/tickets.js:6`) calls `tickets.create` (`src/services/tickets.js:30`), which looks up the reporter, stamps `status: 'open'`, computes `dueAt` from priority via `dueAtFor` (`src/services/tickets.js:18`), and writes a `created` `TicketEvent` (`src/services/tickets.js:44`).

`PATCH /api/tickets/:id/status` (`src/routes/tickets.js:9`) calls `transitionStatus` (`src/services/tickets.js:65`), which looks up the ticket's current status, consults the `TRANSITIONS` map (`src/services/tickets.js:8`) for the allowed next states, rejects with 400 `invalid status transition` if `status` is not in that list, otherwise saves the new status and writes a `status_changed` event with `from`/`to`.

`PATCH /api/tickets/:id/assignee` and `POST /api/tickets/:id/comments` follow the same shape: load the ticket, perform the mutation, append a `TicketEvent` (`assignee_changed`, `commented`).

`GET /api/tickets/:id` (`src/services/tickets.js:56`) returns the ticket alongside its full comment list and its full event list in one response, so a client can render a timeline without three round trips.

Every route under `/api/tickets` runs through `identify` (`src/middleware/identify.js`), which reads the `x-user-id` header, loads that user, and attaches `{ id, role, teamId }` to `req.subject`. **This is not authentication.** There is no password check, no token, no session — anyone can put any user's id in that header and become them. It exists only so the rest of the request has a caller to reason about. Real login (`POST /api/auth/login`, `src/services/auth.js`) checks a bcrypt hash the same way `mern-shop/server/src/services/auth.js` does, but its result (a user object) is not turned into a credential the ticket routes verify. Task 2 adds authorization on top of this identity; nothing here adds authentication on top of it — that would require sessions or tokens, out of scope for this app.

## The core concepts

- **State machine**: the ticket's `status` field only ever moves along edges listed in one exported map (`TRANSITIONS`), never through scattered `if (status === ...)` checks. The map is the single source of truth for what is legal.
- **Audit trail / event sourcing lite**: `TicketEvent` rows are never updated or deleted. They are a append-only record of `{ actor, type, from, to, at }` for every mutation, independent of the ticket's current state.
- **SLA clock**: `dueAt` is a deadline computed once, at creation, from priority. It does not move as the ticket changes state.
- **Queue vs assignment**: `assignee` is a single user reference; there is no notion of a shared queue here, just direct assignment.
- **Soft transition vs hard delete**: tickets are never deleted, only moved to a terminal `closed` state. The domain has no delete endpoint at all.

## Standard practice

- Keep the transition map as data, not `if` statements — a state machine that lives in one object is auditable and testable as a truth table; scattered conditionals are not.
- Write the event before returning, in the same request, not from a background job — an audit log with eventual consistency is not trustworthy the moment something crashes between the two.
- Compute `dueAt` once, from priority, at creation — deriving it from "now" at read time would silently change past commitments every time it's viewed.
- Never let a controller touch a model directly — every mutation goes through the service so the event-writing and validation cannot be bypassed by a new route.
- Model `status` as an enum at the schema level in addition to the service-level state machine — belt and suspenders against a stray direct `Ticket.updateOne`.

## What this toy skips

- Real authentication (sessions, tokens, password-protected routes) — the `x-user-id` header is a stand-in, not a security boundary.
- Business-hours-aware SLA clocks — `dueAt` is a flat wall-clock offset, not "4 business hours," so it can land on a weekend.
- Ticket reassignment queues, round robin, or load-based routing — assignment is a direct, single write.
- Pagination on `GET /api/tickets` — it returns every match.
- Editing or deleting a comment once posted.

## Try it

```
curl -s -X POST http://localhost:5001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"rae@tickets.test","password":"demo1234"}'

curl -s -X POST http://localhost:5001/api/tickets \
  -H 'Content-Type: application/json' \
  -H 'x-user-id: <rae user id from login response>' \
  -d '{"title":"Cannot log in","body":"Password reset link is broken.","priority":"urgent"}'

curl -s http://localhost:5001/api/tickets?status=open \
  -H 'x-user-id: <rae user id>'
```
