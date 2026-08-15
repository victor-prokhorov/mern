# Recommendations

## What this is

`GET /api/recommendations` returns the caller's personalized
"recommended for you" list: up to 10 movies the caller has not rated
or watched, ranked by a score derived from the movie's own quality and
from what the caller's rating and watch history says about which
genres they tend to like.

## How it works here

The ranking algorithm lives in a single pure function,
`rank(candidates, signals)` in `server/src/recommendations/rank.js:32-48`.
It takes an array of movie-like objects and a `signals` object —
`{ likedGenres, dislikedGenres, watchedGenres }` — and returns a sorted,
capped, explained list. It touches no database and no Express; every
rule in the plan (the three multipliers, composition, the 10-item cap,
the tie-break, the reason codes) is exercised directly in
`server/test/recommendations.test.js` without an HTTP request.

`server/src/recommendations/service.js:14-35` is the only place that
loads data. `recommend(userId)`:

1. Loads the caller's `Rating` and `Watch` documents
   (`service.js:16`).
2. Splits ratings into **liked** (`value > 5`) and **disliked**
   (`value <= 5`) movie ids (`service.js:20-21`), and computes
   **watched-but-unrated** movie ids by removing anything the caller
   also rated from their watch list (`service.js:22`).
3. Loads the genres behind each of those three buckets
   (`service.js:23-28`) and asks the repository for the eligible
   candidate pool directly: `averageRating >= 7` and not already rated
   or watched (`server/src/repositories/movies.js`, the
   `findEligible` function, called at `service.js:27`).
4. Hands the candidate pool and the three genre sets to the pure
   `rank()` function (`service.js:34`).

`server/src/controllers/recommendations.js` only calls `recommend` and
serializes the result; `server/src/routes/recommendations.js` only
wires the path; both are mounted in `server/src/app.js`.

**Why the eligibility floor is 7, not a hard genre filter.** The
disliked-genre multiplier (0.8) is a soft penalty, not an exclusion —
rule 3 in the plan is explicit that a disliked-genre movie must still
be able to appear if nothing else is eligible, which is why
`rank()` never removes an item, only reorders it. The `averageRating
>= 7` floor is the only hard filter in the system, and it exists for a
different reason than genre affinity: it guarantees a baseline of
quality regardless of what the algorithm knows about the caller,
which is exactly what a cold-start user needs (see below).

**Why "liked" and "disliked" both come from the same rating list at a
value-5 cutoff**, instead of two separate thresholds with a dead zone
in between. This is a simplification the plan chose deliberately: a
rating of exactly 5 counts as disliked (`rating.value <= 5`), so every
rating always contributes a signal one way or the other. A real system
would likely treat a narrow middle band (4-6, say) as neutral and
contribute no genre signal at all, since a viewer picking the exact
midpoint of a 1-10 scale is telling you "meh" more than "I disliked
this," but that adds a third bucket and a third no-op multiplier for a
demo whose job is to teach the composition rule, not the calibration
of the cutoff itself.

## The core concepts

**Content-based filtering vs. collaborative filtering vs. hybrids.**
This recommender is purely content-based: it scores movies using
attributes of the movies themselves (genre) and the caller's own
history, with no reference to what *other* users liked. Collaborative
filtering instead says "users who liked what you liked also liked X,"
using similarity between users or between items derived from the
whole population's behavior (matrix factorization, item-item
similarity, and so on). Collaborative filtering usually produces
better serendipity — it can recommend something outside a user's
established genres because *similar users* liked it — but it needs a
lot of interaction data before it works well, and it can't say
anything about a brand-new item nobody has rated yet. Most production
systems (Netflix, Spotify) run a hybrid: collaborative filtering as the
main signal, content-based filtering as a fallback for new users and
new items, and a separate freshness/popularity layer on top.

**The cold-start problem.** There are two flavors, and this
implementation handles them very differently. A *new user* (no
ratings, no watches) gets `likedGenres`, `dislikedGenres`, and
`watchedGenres` all empty, so every eligible movie scores as exactly
its own `averageRating` with no multiplier — the system falls back to
"just show me the best-reviewed things," which is the standard
cold-start fallback (popularity as a prior). A *new item* (a movie
just added with no ratings or watches from anyone) works fine here
only because `averageRating` is seeded directly rather than computed
from `Rating` documents — see `server/src/movies/README.md` for why
that is a deliberate simplification. In a system where the average is
actually an aggregate of user ratings, a brand-new movie has no
ratings yet and no average, and needs a separate strategy entirely
(often: don't quality-filter new items, or give them a Bayesian prior
average until enough ratings accumulate).

**Explicit signals vs. implicit signals.** A `Rating` is explicit: the
user made a deliberate judgment call and told you a number. A `Watch`
is implicit: the user did something (finished a movie) that merely
correlates with liking it. Implicit signals are far more abundant —
almost everyone who uses a product generates implicit signals just by
using it, while only a fraction bother to rate anything — but they are
noisier, which is exactly why the watched-but-unrated multiplier
(1.1) is weaker than either rating multiplier (1.2 or 0.8): the same
genre exposure is trusted less when it isn't backed by an explicit
opinion.

**Hard filters vs. soft penalties, and when each is right.** A hard
filter (the `averageRating >= 7` floor, and excluding already-seen
movies) is right when the excluded thing is either definitely
unwanted (you don't want to "recommend" something the user already
watched) or a non-negotiable quality bar. A soft penalty (the 0.8
disliked-genre multiplier) is right when the signal is a preference,
not a certainty — a user who rated one comedy poorly has told you
something about that *one* movie, not necessarily about comedy as a
genre in general, and a hard filter would risk starving the result set
entirely if the eligible pool happens to overlap heavily with that
genre. Rule 3 in the plan is a direct test of this: a disliked-genre
movie must still be able to surface when it is the only eligible
candidate left.

**Popularity bias and the feedback loop.** Sorting purely by
`averageRating` (which is what a new user with no signals gets here)
has a well-known failure mode in production: whatever gets
recommended gets watched more, gets rated more, and its average
climbs or at least stabilizes with a larger sample, while less-exposed
movies stay statistically noisy and rarely surface at all. The system
ends up amplifying whatever was already popular rather than surfacing
the genuinely best match for a given user. This toy doesn't have that
feedback loop wired up (recommendations here don't feed back into
`averageRating` at all — see `server/src/movies/README.md`), but a
real system needs deliberate counter-measures: exploration budgets
(occasionally show something outside the top-scored set to gather
data on it), position-bias correction, or explicit "trending" vs.
"personalized" separation.

**Diversity and serendipity.** A pure relevance sort — always show the
single highest-scoring items — tends to produce a homogeneous list:
if a user liked one thriller, every top result may be a thriller,
which feels repetitive and fails to surface anything the user didn't
already know they'd like. Real systems apply diversity re-ranking
(e.g., cap how many items from the same genre or franchise can appear
consecutively) after the relevance score is computed, precisely
because "10 nearly identical thrillers" is a worse product outcome
than "8 great thrillers and 2 well-chosen wildcards," even though the
former scores higher under a naive relevance metric. This
implementation does not do any diversity re-ranking — the 10 results
are a strict score sort — and that is a known, named gap rather than
an oversight.

**Explainability.** Every returned item carries a `reasons` array
(`rank.js:16-28`) naming exactly which multipliers fired and for which
genre — `LIKED_GENRE:thriller`, `DISLIKED_GENRE:comedy`,
`WATCHED_GENRE:drama`. A recommendation nobody can explain cannot be
debugged: if a user complains "why am I seeing this," or an engineer
needs to understand why a ranking changed after a deploy, a black-box
score is much harder to reason about than an explicit list of which
rules applied.

**Determinism, and why it matters for both testing and trust.**
`rank()` sorts by score descending, then by `_id` ascending on a tie
(`rank.js:39-46`), so the same inputs always produce the same output —
proven directly by calling it twice with identical arguments in the
test suite. This matters for testing because a flaky ordering makes
assertions about "the top result" or "exactly these 10 ids"
impossible to write reliably. It matters for user trust for a subtler
reason: a user who refreshes the page and sees the list reshuffle for
no reason they can perceive loses confidence that the system knows
anything about them, even if every individual item is still
"correct."

**Offline evaluation vs. online evaluation.** Before a change to this
kind of algorithm ships, you'd normally evaluate it offline against
historical data using metrics like precision@k (of the k items
recommended, what fraction did the user actually engage with),
recall@k (of everything the user engaged with, what fraction was in
the top k recommended), and NDCG (normalized discounted cumulative
gain — like precision, but it also rewards getting the *order* right,
discounting a relevant item's contribution the further down the list
it appears, so the same good match is worth far more at position 1
than buried at position 9).
Offline metrics are cheap and safe but can't measure things like
"did showing this recommendation change what the user actually did,"
which is what online A/B testing measures directly, at the cost of
being slow, expensive, and only measurable on real traffic. Production
recommenders typically use offline eval to filter out obviously bad
candidate models cheaply, then online A/B testing to confirm the
winner offline actually moves real behavior.

**Where this would move next.** A pure genre-multiplier score does
not scale past a handful of categorical signals — real systems
typically move to either a vector representation of each movie
(embeddings capturing genre, cast, plot, and viewing co-occurrence
together) served from a vector store for approximate nearest-neighbor
retrieval, or a learned ranking model (logistic regression up through
gradient-boosted trees or a neural ranker) trained on historical
engagement to predict "will this user watch/rate this item highly,"
with the explicit rules here becoming input features to that model
rather than the whole algorithm.

## Standard practice

- **The ranker is a pure function with no database and no Express** —
  one why: the entire scoring algorithm is unit-testable in
  milliseconds, with no test database setup, which is what makes rapid
  iteration on ranking rules practical.
- **Explicit signals outrank implicit ones (1.2/0.8 vs. 1.1)** — one
  why: weighting confidence by how the signal was collected prevents
  noisy, incidental behavior from swamping a deliberate user judgment.
- **A hard quality floor, soft genre penalties** — one why: it
  guarantees a baseline of "this is at least a good movie" for every
  user, including one the system knows nothing about yet, while never
  fully closing off a genre based on a single data point.
- **Deterministic tie-breaking** — one why: it makes the exact result
  set assertable in a test and reproducible for a support engineer
  debugging a specific user's complaint.
- **Every result carries its reason codes** — one why: it turns "why
  did I get this" from an investigation into a database read.

## What this toy skips

- No diversity or serendipity re-ranking; the 10 results are a strict
  score sort and can be genre-homogeneous.
- No offline evaluation harness (no precision@k/recall@k/NDCG
  computed anywhere in this codebase) and no online A/B testing
  infrastructure — both are described above as the real next steps,
  neither is implemented.
- No decay over time — a rating from years ago counts exactly as much
  as one from yesterday.
- No collaborative signal at all — nothing here looks at what other
  users did.
- No feedback loop from a fresh `Rating` back into a movie's
  `averageRating` (see `server/src/movies/README.md`), so the
  popularity-amplification failure mode described above cannot
  actually occur end-to-end in this toy — it is included as a concept
  worth understanding, not a bug this code reproduces.

## Try it

```
npm run seed
npm start

curl http://localhost:5001/api/recommendations \
  -H "x-user-id: <a user id from the seed output>"
```

A user with no ratings or watches gets the top-rated eligible movies
in the seed data. Rate a movie highly (`POST /api/ratings`), then call
`GET /api/recommendations` again — movies sharing that movie's genres
should move up, each carrying a `LIKED_GENRE:<genre>` reason.
