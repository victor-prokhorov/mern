# Authorization policy engine

## What this is

A small policy decision point: given who is asking, what they want to do, and to what, it returns a decision with a reason, and every ticket service function calls it before doing anything. This is authorization (what you're allowed to do), not authentication (who you are) — see `server/src/tickets/README.md` for how identity is established here.

## How it works here

`decide(ruleSet, request)` (`src/policy/engine.js:11`) is the pure decision function: it filters `ruleSet` down to the rules that match the request (`ruleMatches`, `src/policy/engine.js:4`), then applies **deny-overrides** — if any matching rule denies, the result is deny regardless of any matching permit (`src/policy/engine.js:13-14`) — and falls through to **default deny** if nothing matched at all (`src/policy/engine.js:17`).

`authorize(request)` (`src/policy/engine.js:20`) is the enforcement wrapper: it calls `decide` against the real policy set in `policies.js`, logs the ruleId and reason to the server console on a deny, and throws `ForbiddenError('forbidden')` — a generic message, because the caller does not get to learn which rule stopped them or why (`src/policy/engine.js:22-24`).

Every mutating and reading ticket service function calls `authorize` before touching data: `create` (`src/services/tickets.js:34`), `get` (`src/services/tickets.js:68`), `transitionStatus` (`src/services/tickets.js:78`), `assign` (`src/services/tickets.js:90`), `addComment` (`src/services/tickets.js:103`). Controllers never check a role themselves — they pass `req.subject` (set by `identify`, `src/middleware/identify.js`) straight through to the service, which builds the `{ subject, action, resource, context }` request and asks the engine.

`policies.js` holds the rule set as one array, each rule `{ id, effect, actions, roles, reason, condition }`. The six rules: reporters may create tickets and may read/comment on tickets they reported (`ownsTicket`, `src/policy/policies.js:1-3`); agents may read, comment, transition and assign tickets in their own team (`sameTeam`, `src/policy/policies.js:5-7`); admins get a wildcard permit on every action; an explicit deny rule blocks even admins from `ticket:delete`, which only means something because deny-overrides beats the wildcard permit; and a deny rule blocks anyone but an admin from transitioning a ticket whose `resource.status` is `closed` (`ticketIsClosed`, `src/policy/policies.js:9-11`) — a condition on resource state, not on role alone.

`GET /api/tickets` (list) does not call `authorize` per row. Instead `list` (`src/services/tickets.js:56`) scopes the database query itself: reporters only ever see their own tickets, agents only their team's. This is a pragmatic stand-in for row-level authorization on a collection endpoint — see "What this toy skips" for the gap it leaves. `test/tickets.test.js`'s "list scoping" suite pins this down directly: it asserts a reporter or agent cannot see out-of-scope tickets even when every query filter matches, and was confirmed to fail if either scoping line in `list()` is removed.

## The core concepts

- **Authentication vs authorization**: authentication answers "who is this"; authorization answers "what can they do." This app's authentication is a placeholder (`x-user-id`); its authorization is real and independently testable.
- **RBAC (role-based access control)**: permissions attached to a role (`reporter`, `agent`, `admin`). Scales well until you need per-resource nuance.
- **ABAC (attribute-based access control)**: permissions computed from attributes of the request — here, "is this my ticket" and "is this ticket in my team" and "is this ticket closed." RBAC alone cannot express "your own tickets"; ABAC conditions can. This engine is RBAC plus ABAC conditions, which is where most real systems land before reaching for a dedicated policy language.
- **ReBAC (relationship-based access control)**: permissions derived from a graph of relationships (Google Docs sharing, org charts). Not needed here because relationships are shallow (owns / same-team), but it is the next step when "my team" becomes "my team, my manager's team, and anyone I shared this with."
- **PDP / PEP / PIP / PAP**: the Policy Decision Point is `decide` — it answers yes/no. The Policy Enforcement Point is every service function calling `authorize` and letting it throw — it acts on the answer. The Policy Information Point is the data the condition reads (the ticket's `reporter`, `teamId`, `status`) — here it's just the resource already in hand, not a separate lookup. The Policy Administration Point is `policies.js` — the place a human edits to change the rules. Naming these separately matters because in real systems they are often different processes or even different services.
- **Default deny**: an empty or non-matching policy set produces deny, never permit. The alternative (default permit) means every unanticipated action is allowed, which is the wrong failure mode for access control.
- **Deny-overrides**: when rules conflict, deny wins. The alternative (permit-overrides) means one overly broad permit rule can silently punch a hole through every deny rule meant to constrain it — which is exactly what the `admin-no-delete` / `admin-wildcard` pair in this policy set is built to demonstrate.
- **Policies as data**: the rule set is an array of plain objects, not `if` statements scattered through the service layer. That makes it readable in one screen, diffable in review, and testable as a table of inputs and expected decisions — which is what `test/policy.test.js` does.
- **Row-level vs endpoint-level authorization**: checking "can this role hit this endpoint" is necessary but not sufficient — an agent hitting `GET /api/tickets/:id` is the right endpoint for their role, but the wrong ticket (someone else's team) is still a data leak if the row itself isn't checked. Every read/write here checks the actual ticket, not just the route — except the list endpoint, which scopes by query instead of a per-row `decide` call (see "How it works here" and "What this toy skips"); that is exactly the row-level-vs-endpoint-level distinction this bullet is naming, applied to this app's one collection endpoint.
- **The confused-deputy problem**: a service that trusts its caller's claims about identity or intent, and gets tricked into misusing its own authority on the caller's behalf. Centralizing checks in `authorize` — rather than trusting a client-supplied "is_admin" flag or skipping the check because "the controller already validated it" — is the standard defense.

## Standard practice

- One enforcement point per action, in the service layer, never the controller — a controller-level role check is easy to forget on the next endpoint and impossible to audit as a single list.
- Decisions carry a reason and a ruleId, never a bare boolean — a system that says "no" without saying which rule fired is not debuggable in production and not auditable after the fact.
- Default deny — an unanticipated action, resource, or role must fail closed, not open.
- Deny-overrides — safety rules (delete bans, closed-ticket guards) must be able to override broad permits without the permit's author having to know about every future deny rule.
- Keep the 403 body generic and put the reason only in the server log — telling an unauthorized caller exactly which rule and attribute blocked them hands them a map for finding a path around it.
- Test the policy set as a truth table — one test per rule interaction (default deny, deny-overrides, each role boundary), not just end-to-end HTTP happy paths.

## What this toy skips

- Row-level authorization on `GET /api/tickets`: it filters the query by role instead of running every candidate row through `decide`. That is faster and matches how real apps scope collection queries, but it means the list endpoint's access boundary lives in `list()`'s filter logic, not in the policy engine, so it is not covered by the same audit trail as the per-ticket checks.
- Delegation, impersonation, or "act as" flows.
- Policy versioning, staged rollout, or a UI/API for editing `policies.js` without a deploy.
- Caching decisions — every request re-evaluates the full rule set, which is fine at this scale and wrong at high volume.
- Obligations (e.g., "permit, but redact these fields") — decisions here are effect-only, not permit-with-conditions.
- What OPA/Cedar/Casbin give you over this: a declarative policy language independent of your programming language (so policies can be authored, versioned, and reviewed outside a code deploy), formal conflict analysis and testing tooling, partial evaluation for pushing filters into a database query automatically instead of hand-writing `list()`'s scoping, and often a separate decision service so PDP and PEP can scale and be audited independently of the application. This engine is a teaching-sized version of the same shape, wired directly into the process.

## Try it

```
curl -s -X POST http://localhost:5001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"rae@tickets.test","password":"demo1234"}'

curl -s -X POST http://localhost:5001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"sam@tickets.test","password":"demo1234"}'

curl -s -X POST http://localhost:5001/api/tickets -H 'Content-Type: application/json' \
  -H 'x-user-id: <sam id>' -d '{"title":"t","body":"b","priority":"normal"}'

curl -s http://localhost:5001/api/tickets/<ticket id from above> -H 'x-user-id: <rae id>'
```

The last call returns 403 `{"error":"forbidden"}` — rae is a reporter and this ticket belongs to sam.
