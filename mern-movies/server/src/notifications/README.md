# Follow and notify

## What this is

Following an actor means you get notified when that actor shows up in
a newly added movie. `POST /api/actors/:id/follow` and
`DELETE /api/actors/:id/follow` manage the subscription; when an admin
creates a movie, every follower of every cast member gets a
`Notification`; `GET /api/notifications` and
`POST /api/notifications/:id/read` read and acknowledge them.

## How it works here

`Follow` (`server/src/models/follow.js`) is `{ user, actor, createdAt }`
with a unique index on `{ user, actor }`. `Notification`
(`server/src/models/notification.js`) is
`{ user, type: 'actor_in_new_movie', actor, movie, readAt, createdAt }`
with a unique index on `{ user, movie, actor }` — one row per
(follower, movie, followed-actor) triple, which is exactly the
granularity the plan asks for: a user following two cast members of
the same movie gets two notifications, one per actor, not one per
movie.

The fan-out itself is one function,
`fanoutNewMovie(movie)` in `server/src/notifications/fanout.js:4-16`:
it collects every distinct actor id in the movie's cast, does **one**
query for every `Follow` row referencing any of them
(`fanout.js:7`, via `followsRepo.findByActors`), and if there are any,
builds one document per (follower, actor) pair and writes them with a
**single** `insertMany(docs, { ordered: false })`
(`server/src/repositories/notifications.js:10`). There is no
per-follower round trip anywhere in this path.

`server/src/services/movies.js:19-31` (`create`) is where fan-out gets
triggered, and the order matters: `moviesRepo.create` runs first
(`movies.js:24`) and only then does `fanoutNewMovie` run
(`movies.js:26`), wrapped in a `try`/`catch` that logs and swallows any
error (`movies.js:25-29`). The movie is fully persisted before the
fan-out is even attempted, and nothing the fan-out does can turn a
successful movie creation into a failed HTTP response.

Follow/unfollow are ordinary services
(`server/src/services/follows.js`): `follow` upserts
(`server/src/repositories/follows.js:3-9`) so following twice is a
no-op rather than a duplicate-key error, and `unfollow` is a plain
delete. Notifications are read via
`server/src/services/notifications.js`, backed by
`server/src/repositories/notifications.js:17-19`, which sorts unread
first by ordering `readAt` ascending — a `null` `readAt` sorts before
any real date in MongoDB's BSON comparison order, where Null sits
second from the bottom (just above MinKey) and Date sits near the top,
then `createdAt` descending as the tiebreak. This is load-bearing but
implicit: the ordering is a property of BSON type comparison, not
something the query states, and MongoDB treats a missing field as null
for sort purposes too, so the behaviour would survive `readAt` being
absent rather than explicitly `null`.

## The core concepts

**Fan-out-on-write vs. fan-out-on-read.** This system fans out on
write: the moment a qualifying movie is created, a `Notification` row
is materialized for every follower who cares. The alternative,
fan-out-on-read, would store nothing at write time and instead, when a
user opens their notifications, compute on the fly which movies were
added recently that feature an actor they follow. Fan-out-on-write
trades storage (one row per follower per event, potentially a lot of
rows) for read speed (`GET /api/notifications` is a single indexed
query, `server/src/repositories/notifications.js:17-19`, no
computation). Fan-out-on-read trades that storage back for slower,
heavier reads, because every read has to reconstruct what "new for
this user" means from scratch.

The usual summary — "notification and feed systems choose
fan-out-on-write because reads vastly outnumber writes" — is the right
instinct but the wrong resolution, and the primary source is worth
reading because it gets more specific. Silberstein, Terrace, Cooper
and Ramakrishnan's SIGMOD 2010 paper *Feeding Frenzy* analyses exactly
this choice at Yahoo! and concludes that neither strategy wins
globally. The best performance comes from *selectively* materializing
each consumer's feed: "events from high-rate producers are retrieved at
query time, while events from lower-rate producers are materialized in
advance." Their formal result is the useful part — global cost is
minimized by making a purely **local** decision for each
producer/consumer pair, driven by the ratio between that producer's
update rate (how often it emits an event) and that consumer's view
rate (how often they read their feed). So the real question is not
"push or pull" for the system, it is "push or pull" for each edge, and
the deciding quantity is a rate ratio, not a global read/write ratio.

For this app, the rate ratio makes fan-out-on-write the obvious
choice: movies are created rarely, notification lists are read often.
That is the right answer here; it is just worth knowing it is an answer
to a specific question rather than a universal rule.

**The celebrity problem.** Fan-out-on-write breaks down when a single
write fans out to an enormous number of rows — an actor with a million
followers turns one movie creation into a million notification writes.
This implementation is bulk (one query, one insert, `fanout.js:7,15`)
rather than one-row-at-a-time, which is the first and cheapest
mitigation, but a genuinely huge fan-out usually needs more: chunking
the insert so a single operation doesn't hold a connection too long,
doing the fan-out asynchronously via a queue instead of inline with the
HTTP request, or the hybrid — stop materializing the highest-rate
producers, and instead merge their recent events into each follower's
feed at read time.

Two corrections to the folk version of that hybrid, both worth
carrying. First, the threshold is not really "follower count." Follower
count drives the *cost* of materializing, but per *Feeding Frenzy* the
decision quantity is the producer's update rate against the consumer's
view rate — a millionaire-follower account that posts once a year is a
fine candidate for push, and a low-follower account emitting constantly
into a rarely-read feed is not.

Second, be careful attributing this to Twitter as deployed history.
Raffi Krikorian's 2012 QCon talk *Timelines at Scale* is the canonical
description of Twitter's fan-out-on-write architecture — every tweet
fanned out into a large Redis cluster, up to ~20K inserts per tweet,
each timeline entry holding little more than a tweet id — and in that
talk, not fanning out high-value accounts and merging their tweets in
at read time was presented as the *planned* fix for the fan-out
latency problem, not as something already running. The system X
open-sourced in 2023 looks different again: its home-timeline pipeline
sources roughly half of in-network candidates from the Earlybird search
index at request time, then ranks them, rather than reading a
pre-materialized per-user timeline. Take the hybrid as a sound design
principle with a real analytical basis, not as "this is what Twitter
does."

**Idempotency keys and unique indexes as dedupe.** The unique index on
`{ user, movie, actor }` is what makes "run the fan-out twice" safe.
MongoDB's guarantee is stated plainly in the manual: "a unique compound
index ensures that any given combination of the index key values
appears at most once." The second run tries to insert the same triples,
the server refuses them, and the repository's `insertMany` catches that
specific failure and returns whatever *did* insert rather than throwing
(`repositories/notifications.js:11-13`). This is the same idea as an
idempotency key on a payment API — a natural composite key derived from
"what this operation is about" turns "did this already happen" into a
question the database itself answers, rather than something the caller
has to track separately. See
`../../../../mern-tickets/server/src/hooks/README.md` for the same
distinction argued from the other side (a pipeline that runs at most
once, where idempotency is about rejecting a resubmission rather than
about handlers being safe to re-run).

Two mechanical details behind that, both verified against a live
MongoDB 7 rather than assumed:

- `ordered: false` is what makes partial success possible. The manual:
  with `ordered: true` "if an insert fails, the server does not
  continue inserting records"; with `ordered: false` "the server
  continues inserting records." Replaying a fan-out where one of six
  rows is new therefore inserts that one row and reports five
  duplicate-key write errors, rather than aborting at the first
  duplicate.
- `err.insertedDocs` is a Mongoose addition, not a MongoDB field. On
  the replay above, the thrown `MongoBulkWriteError` carries
  `code: 11000`, five entries in `writeErrors`, and an `insertedDocs`
  array holding exactly the one document that landed — which is what
  `repositories/notifications.js:12` returns instead of throwing.

There is a real gap underneath all of this that the code does not
close. The unique index is declared with `schema.index(...,
{ unique: true })`, and Mongoose is explicit that this "is just a
shorthand for creating a MongoDB unique index" — it is not a validator,
and the index is built asynchronously after the model is compiled.
Nothing on the server's startup path (`src/db.js`, `src/index.js`,
`src/seed.js`) waits for that build. The test helper does:
`test/helpers.js:10` calls `syncIndexes()` on every model after
dropping the database, which is why the dedupe behaviour is reliably
testable. On a genuinely fresh production database there is a window at
first boot in which the index does not exist yet and a duplicate
fan-out would succeed in writing duplicate rows. Awaiting
`Model.init()` before serving traffic is the documented fix.

**At-least-once vs. at-most-once vs. exactly-once.** The movie write
and the notification write are two separate operations with no shared
transaction, so this system must pick a failure mode. If it retried a
failed fan-out, a follower could be notified twice for the same movie
(except that the unique index prevents exactly that). If it does not
retry, a follower can be notified zero times when the write fails.
This implementation chooses **best-effort, at-most-once**: the
`try`/`catch` in `movies.js:25-29` logs a fan-out failure and drops it,
never retrying. Note that this is at-most-once *by policy*, not by
necessity — the dedupe machinery for at-least-once is already in place,
so the change is a retry, not a redesign.

The "exactly-once is a fiction" line needs stating carefully, because
as usually written it is both right and wrong. Split the two ideas:

- **Exactly-once *delivery* is an impossibility result**, not an
  engineering difficulty. Tyler Treat's write-up is the crisp version:
  "FLP and the Two Generals Problem are not design complexities, they
  are *impossibility results*." Over an unreliable network, sender and
  receiver cannot reach agreement that a message was delivered exactly
  once, because there is always a window in which a retry and a
  duplicate are indistinguishable.
- **Exactly-once *effects* are entirely achievable**, and are what
  every real system means when it advertises the term. The mechanism is
  at-least-once delivery plus idempotent processing or deduplication —
  which is what the unique index above provides. Treat again: "the way
  we achieve exactly-once delivery in practice is by faking it. Either
  the messages themselves should be idempotent... or we remove the need
  for idempotency through deduplication." The usual name for the
  combination is **effectively-once**.

The nuance that trips people up is that Kafka's "exactly-once
semantics" is a real, shipped feature, so "exactly-once is a myth"
sounds like a contradiction of it. It is not, because Kafka's guarantee
is scoped, and Confluent's own announcement says where the scope ends:
exactly-once holds for a read-process-write loop *inside* Kafka
(idempotent producer plus transactions spanning offsets and output
records), and "if the event streaming app written in Streams makes an
RPC call to update some remote stores... the resulting side effects
would not be guaranteed exactly once." Exactly-once within a
transactional boundary you control: real. Exactly-once delivery to an
arbitrary external system: not available, and the fix there is
idempotency at the destination.

**The transactional outbox — the real fix.** The honest problem with
this implementation is that "create the movie" and "notify the
followers" are two separate writes to two separate collections with no
atomicity between them: if the process crashes between them, the movie
exists and the notifications silently never happen, with nothing left
behind to say they were owed. The transactional outbox pattern — whose
canonical statement answers exactly the question "how to atomically
update the database and send messages to a message broker?" — fixes
this by first storing the message "in the database as part of the
transaction that updates the business entities," after which "a
separate process then sends the messages to the message broker." The
intent to fan out is durable the instant the movie is durable, because
they are the same write.

Two things about that worth knowing before reaching for it:

- **The relay comes in two flavours.** *Polling publisher* queries the
  outbox table on an interval; *transaction log tailing* reads the
  database's own replication log (MySQL binlog, Postgres WAL) and
  publishes each inserted outbox row. Debezium's write-up is the
  clearest practical treatment of the log-tailing variant, and also
  makes the point that motivates the whole pattern: by modifying only
  one resource, the service avoids the inconsistency inherent in
  writing to a database and a broker without a shared transaction, and
  gets "read your own writes" for free.
- **The outbox does not deliver exactly once.** Its relay is
  at-least-once — the canonical description lists avoiding duplicate
  publishing as a known drawback of log tailing — so consumers still
  need to be idempotent. The outbox upgrades "notifications are
  best-effort" to "notifications are guaranteed eventually, with
  retries, and observable while pending." It does not remove the need
  for the unique index; the two solve different halves.

There is a MongoDB-specific wrinkle. The pattern needs a transaction
spanning the movie write and the outbox write, and MongoDB does support
multi-document transactions — but only on a replica set (4.0+) or a
sharded cluster (4.2+), never on a standalone `mongod`, which is what
the development setup here runs. So "no transactional outbox" in this
app is not only unimplemented, it is unavailable without changing the
deployment topology first. MongoDB's own guidance also pushes back on
reaching for transactions by default: "the availability of distributed
transactions should not be a replacement for effective schema design,"
and for many cases modelling the data appropriately avoids needing them
at all.

This implementation has none of it: no outbox collection, no background
worker, no retry. It swallows the failure and moves on.

**Backfill and replay.** Because `fanoutNewMovie` is idempotent by
construction, it is also naturally replayable: if a bug in this
implementation silently dropped fan-out for a batch of movies added
last week, the fix is to re-run `fanoutNewMovie` for each of those
movies — the unique index guarantees already-delivered notifications
are skipped and only the missing ones are created. A system with a
transactional outbox gets this almost for free (replay the outbox); a
system without one, like this toy, needs an operator to manually
identify which movies need re-processing.

**Notification fatigue, batching and digests.** This implementation
sends one row per (follower, actor, movie) unconditionally — a user
following ten actors who all happen to appear in the same ensemble
movie gets ten separate rows in one shot. A real notification system
usually caps or batches this: collapsing multiple triggers into one
digest ("5 actors you follow are in this movie") instead of one
notification per trigger, and rate-limiting or batching over time so
an active user doesn't get flooded. None of that batching exists here.

**Read state and per-device sync.** `readAt` is a single timestamp per
notification row, which works for one client but does not model "read
on my phone, should also show as read when I open my laptop" beyond
the trivial case of both clients reading the same row from the same
database — there is no separate per-device read cursor or
last-synced-at concept here, which a genuinely multi-device product
usually needs.

**Preferences and unsubscribe as a first-class requirement.**
Unfollowing an actor (`DELETE /api/actors/:id/follow`) is the only
preference control in this system. `unfollow` is a plain delete
(`services/follows.js`), so it stops *future* fan-out but, by design,
never touches notifications already created — a test in
`server/test/notifications.test.js` proves existing notifications
survive an unfollow. A real system usually offers finer-grained
preferences than a binary follow/unfollow (mute this actor's
notifications without unfollowing, choose digest frequency, opt out of
this notification type entirely), none of which exist here.

## Standard practice

- **Bulk fan-out: one query, one insert** — one why: a per-follower
  round trip turns a single movie creation into hundreds or thousands
  of database calls, which is both slow and is exactly the celebrity
  problem waiting to happen.
- **`ordered: false` on the bulk insert** — one why: with `ordered:
  true` (the default), the first duplicate-key error in the batch
  would abort every row after it; `ordered: false` lets MongoDB attempt
  every row independently so one bad row never blocks the good ones.
- **A unique compound index doing the dedupe, not application logic**
  — one why: a "check if it exists, then insert" pattern racing against
  a concurrent identical fan-out has a window where both checks pass
  and both inserts happen; the database refusing the duplicate at the
  index level has no such window. Caveat, documented above: nothing on
  the startup path awaits the index build, so the guarantee is absent
  for a window on a brand-new database.
- **Fan-out wrapped in `try`/`catch` around the movie-creation
  response** — one why: a secondary side effect (notifying people)
  should never be able to fail the primary operation (creating the
  movie) that the caller is actually waiting on.
- **Fan-out after the movie is persisted, never before** — one why:
  notifying someone about a movie that then fails to save would be
  notifying them about something that doesn't exist.

## What this toy skips

- No transactional outbox — described above as the real fix, not
  implemented. A crash between the movie write and the fan-out call
  silently drops notifications with no record that they were owed. Note
  this one is blocked as well as unbuilt: MongoDB multi-document
  transactions need a replica set or sharded cluster, and the
  development setup is a standalone `mongod`.
- No retry queue for failed fan-outs — a failure is logged
  (`movies.js:28`) and never attempted again automatically. This is the
  single change that would move the system from at-most-once to
  effectively-once, since the dedupe half is already built.
- No wait for index builds on startup — the unique index that the
  dedupe depends on is created asynchronously by Mongoose and never
  awaited outside the test helper, so a brand-new database has a window
  with no dedupe guarantee at all.
- No celebrity-scale batching or async processing — fan-out runs
  inline with the HTTP request, on however many followers exist.
- No digesting or rate-limiting — every trigger produces its own row.
- No per-device read-sync, no notification preferences beyond
  follow/unfollow, no email or push delivery — this API only ever
  writes rows a client is expected to poll via `GET /api/notifications`.

## Try it

```
npm run seed
npm start

curl -X POST http://localhost:5001/api/actors/<actor id from GET /api/actors>/follow \
  -H "x-user-id: <user id from the seed output>"

curl -X POST http://localhost:5001/api/movies \
  -H 'Content-Type: application/json' \
  -H "x-user-id: <admin user id from the seed output>" \
  -d '{"title":"New Release","genres":["action"],"cast":["<actor id from GET /api/actors>"],"averageRating":8,"releasedAt":"2024-01-01"}'

curl http://localhost:5001/api/notifications -H "x-user-id: <the same user id you followed with>"

curl -X POST http://localhost:5001/api/notifications/<notification id from GET /api/notifications>/read \
  -H "x-user-id: <the same user id>"
```

## Further reading

Every link below was fetched and checked against what this README
claims.

**Fan-out: the actual literature, not the interview answer**

- [Feeding Frenzy: Selectively Materializing Users' Event Feeds (Silberstein, Terrace, Cooper, Ramakrishnan, SIGMOD 2010)](https://jeffterrace.com/docs/feeding-frenzy-sigmod10-web.pdf)
  — the primary source for push vs pull, and the one that replaces the
  hand-wave with a decision rule. The result worth carrying: global
  cost is minimized by a local per-producer/consumer-pair decision
  driven by the producer's update rate against the consumer's view
  rate. Twelve pages, and it will change how you frame the question.
- [Timelines at Scale (Raffi Krikorian, QCon San Francisco 2012)](https://www.infoq.com/presentations/Twitter-Timeline-Scalability)
  — the canonical talk on Twitter's fan-out-on-write home timeline,
  from the person who ran it. Watch it for the operational texture
  (what a write amplification of 20K inserts actually costs), and note
  that the celebrity merge-at-read is presented as the planned fix.
- [The Architecture Twitter Uses to Deal with 150M Active Users (High Scalability)](https://highscalability.com/the-architecture-twitter-uses-to-deal-with-150m-active-users/)
  — a detailed written summary of that talk, useful because it is
  searchable and quotable where a video is not. This is the source for
  the claim above that not fanning out high-value accounts was
  proposed rather than deployed at the time.
- [X's open-sourced recommendation algorithm](https://github.com/twitter/the-algorithm)
  — the 2023 successor system, worth a browse specifically because it
  does not match the 2012 story: in-network home-timeline candidates
  come from the Earlybird search index at request time, then through
  light and heavy rankers. A good corrective to treating any one
  architecture talk as timeless.

**Delivery semantics**

- [You Cannot Have Exactly-Once Delivery (Tyler Treat, 2015)](https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/)
  — the argument stated properly: FLP and Two Generals are
  impossibility results, not hard problems, and the practical answer is
  at-least-once plus idempotency. Read this before repeating the
  slogan, so you repeat the precise version.
- [Exactly-Once Semantics Are Possible: Here's How Kafka Does It (Narkhede & Wang, Confluent)](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)
  — the other half of the same argument. Explains the idempotent
  producer and transactions, and is explicit that the guarantee covers
  read-process-write inside Kafka and not RPCs to external stores.
  Reading it alongside Treat is what makes both claims fit together.

**The outbox pattern**

- [Pattern: Transactional Outbox (Chris Richardson, microservices.io)](https://microservices.io/patterns/data/transactional-outbox.html)
  — the canonical one-page statement of the pattern: the problem, the
  solution, and the two relay implementations.
- [Pattern: Transaction Log Tailing (microservices.io)](https://microservices.io/patterns/data/transaction-log-tailing.html)
  — the CDC-based relay, including the drawback that matters here:
  avoiding duplicate publication is on you, so the outbox is
  at-least-once.
- [Reliable Microservices Data Exchange With the Outbox Pattern (Debezium, 2019)](https://debezium.io/blog/2019/02/19/reliable-microservices-data-exchange-with-the-outbox-pattern/)
  — the practical write-up, from the project most people end up using
  for log tailing. Covers why writing only to your own database is the
  point, and what the event router actually does.

**What MongoDB guarantees, from the manual**

- [Unique Indexes](https://www.mongodb.com/docs/manual/core/index-unique/)
  — the exact guarantee the dedupe rests on, including compound-index
  and null-handling behaviour.
- [insertMany: ordered vs unordered](https://www.mongodb.com/docs/manual/reference/method/db.collection.insertMany/)
  — the documented difference behind `ordered: false`, with worked
  examples of what gets inserted when part of a batch fails.
- [Comparison/Sort Order](https://www.mongodb.com/docs/manual/reference/bson-type-comparison-order/)
  — the BSON type ordering that makes `sort({ readAt: 1 })` put unread
  notifications first, and the note that a missing field sorts as null.
- [Transactions](https://www.mongodb.com/docs/manual/core/transactions/)
  — what an outbox here would require: replica set or sharded cluster
  only, plus MongoDB's own argument for modelling your way out of
  needing them.
- [Retryable Writes](https://www.mongodb.com/docs/manual/core/retryable-writes/)
  — worth reading to know what it does *not* cover. Drivers retry once,
  for transient network errors and elections; an application-level
  duplicate-key error is not retried for you.

**Elsewhere in this monorepo**

- `../../../../mern-tickets/server/src/hooks/README.md` — idempotency
  from the opposite direction: a synchronous pipeline that runs at most
  once, where the question is rejecting a client's retry rather than
  making handlers safe to re-run.
- `../../../../mern-shop/server/src/rateLimit/README.md` — the same
  duplicate-key-on-concurrent-upsert situation as here, but with the
  retry actually implemented, so the two READMEs bracket the choice.
- `../../../../mern-shop/server/src/fraud/README.md` — what the absence
  of an idempotency key costs at an endpoint where retries have side
  effects beyond a duplicate row.
- `../movies/README.md` — where the fan-out is triggered from, and the
  upsert-under-concurrency behaviour the dedupe here relies on.
