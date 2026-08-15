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
similarity, and so on). The trade between the two families is stated
directly in Hu, Koren and Volinsky's implicit-feedback paper:
collaborative filtering is domain-free and "can address aspects of the
data that are often elusive and difficult to profile using content
based techniques," and is "generally more accurate," but "suffers from
the cold start problem, due to its inability to address products new
to the system, for which content based approaches would be adequate."

Note the exact shape of that claim, because the informal version
overreaches. It is a claim about accuracy and about cold start. It is
*not* a claim that collaborative filtering is more serendipitous.
Collaborative filtering can reach outside a user's established genres,
because the similarity is derived from population behavior rather than
item attributes — but serendipity is a distinct objective with its own
definitions and its own measurements (see below), not a free by-product
of using a different signal source. Treat "collaborative filtering is
more serendipitous" as a plausible hypothesis, not a result.

Burke's 2002 survey named the hybrid family and is still the reference
for the taxonomy, but how hybrids get built has changed since. A
current large-scale recommender is not "collaborative filtering with
content-based filtering bolted on as a fallback." It is a multi-stage
pipeline — cheap candidate retrieval over the whole catalogue, then an
expensive ranking model over a few hundred survivors — in which item
attributes and interaction history are both simply features consumed
by the same learned models. The content/collaborative split survives as
a way to describe where a signal came from, not as a description of
two separate systems. See "where this would move next" below.

**The cold-start problem.** The standard treatment names three cases,
not two: new user, new item, and new system (a recommender with no
interaction history at all). This implementation handles the first
two very differently and does not face the third, because the seed
data ships with ratings already in place.

A *new user* (no ratings, no watches) gets `likedGenres`,
`dislikedGenres`, and `watchedGenres` all empty, so every eligible
movie scores as exactly its own `averageRating` with no multiplier —
the system falls back to "just show me the best-reviewed things,"
which is the standard cold-start fallback (popularity as a prior). A
*new item* (a movie just added with no ratings or watches from anyone)
works fine here only because `averageRating` is seeded directly rather
than computed from `Rating` documents — see
`server/src/movies/README.md` for why that is a deliberate
simplification. In a system where the average is actually an aggregate
of user ratings, a brand-new movie has no ratings yet and no average,
and needs a separate strategy entirely (often: don't quality-filter
new items, or give them a Bayesian prior average until enough ratings
accumulate). This is the case where a content-based recommender like
this one has the structural advantage over a collaborative one: genre
is known the moment the movie row exists, whereas co-occurrence with
other movies does not exist until people start watching it.

**Explicit signals vs. implicit signals.** A `Rating` is explicit: the
user made a deliberate judgment call and told you a number. A `Watch`
is implicit: the user did something (finished a movie) that merely
correlates with liking it. Implicit signals are far more abundant —
almost everyone who uses a product generates implicit signals just by
using it, while only a fraction bother to rate anything — but they are
noisier, which is why the watched-but-unrated multiplier (1.1) is
weaker than either rating multiplier (1.2 or 0.8): the same genre
exposure is trusted less when it isn't backed by an explicit opinion.

That weaker multiplier is a crude stand-in for the real treatment,
which is worth knowing because it is structurally different. Hu, Koren
and Volinsky's point is not "implicit signals are weaker, so scale them
down." It is that implicit feedback has two properties explicit
feedback does not: there is **no negative signal** at all (not watching
a movie is not evidence of dislike — it is far more likely to be
evidence of never having heard of it), and the numeric magnitude of an
implicit signal expresses **confidence, not preference** (watching
something five times does not mean you like it five times as much; it
means you are five times more certain the single binary "prefers this"
is true). The standard model therefore splits one implicit observation
into a binary preference and a separate confidence weight, rather than
folding both into one multiplier as this code does.

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
has a documented failure mode in production: whatever gets
recommended gets watched more, gets rated more, and its average
climbs or at least stabilizes with a larger sample, while less-exposed
movies stay statistically noisy and rarely surface at all. The system
ends up amplifying whatever was already popular rather than surfacing
the genuinely best match for a given user.

Worth being precise about what the research actually measures here,
because "the algorithm just shows popular stuff" is the folklore
version. Abdollahpouri, Mansoury, Burke and Mobasher measured it by
splitting users into groups by how much of their own history is
long-tail — niche, diverse, blockbuster-focused — and comparing what
each group asks for against what each group is served. The finding is
a *disparity*, not just a skew: recommendations stay "extremely
concentrated on popular items even if a user is interested in
long-tail and non-popular items." So popularity bias is not only an
efficiency problem for the catalogue's tail, it is an unfairness
problem that lands hardest on precisely the users whose taste the
recommender was supposed to serve. The usual measurement is long-tail
coverage — what share of the catalogue can ever be recommended at all.

This toy doesn't have that feedback loop wired up (recommendations here
don't feed back into `averageRating` at all — see
`server/src/movies/README.md`), but a real system needs deliberate
counter-measures: exploration budgets (occasionally show something
outside the top-scored set to gather data on it), position-bias
correction, or explicit "trending" vs. "personalized" separation.

**Diversity and serendipity.** These are two of the four standard
"beyond-accuracy" objectives, and they are not synonyms. Kaminskas and
Bridge's survey is the reference that pins them down:

- **Diversity** is a property of a single list — how dissimilar its
  items are from each other (intra-list distance).
- **Novelty** is a property of an item relative to one user — whether
  they had already heard of it.
- **Serendipity** is novelty *plus* relevance *plus* surprise: an item
  the user did not expect and would not have found, that turns out to
  be good. An item that is merely obscure is novel, not serendipitous.
- **Coverage** is a property of the system — what fraction of the
  catalogue is reachable through recommendations at all.

They interact rather than stacking: the same survey found rating-based
diversity positively correlated with novelty, and novelty in turn
improving coverage, so optimizing one moves the others in ways worth
measuring rather than assuming.

The reason a pure relevance sort is a problem is that it optimizes
none of these. If a user liked one thriller, every top result may be a
thriller, which is repetitive and surfaces nothing the user did not
already know they would like. Real systems apply diversity re-ranking
after the relevance score is computed — the classic technique is
maximal marginal relevance, which greedily picks the next item to
maximize a weighted combination of "relevant to the query" and
"dissimilar to what is already on the list."

The related "filter bubble" claim deserves the same care, because the
folklore version overstates the evidence. Nguyen, Hui, Harper, Terveen
and Konstan measured content diversity per individual over time on
MovieLens and found the narrowing is real but *slight* — and, more
interestingly, that users who actually consumed the recommendations
they were shown experienced *less* narrowing than users who ignored
them, while also rating items more positively. So the honest statement
is "recommenders measurably narrow the set of content users see, by a
modest amount, and taking the recommendations mitigates rather than
worsens it," not "recommenders trap users in a bubble."

This implementation does no diversity re-ranking — the 10 results are
a strict score sort — and that is a known, named gap rather than an
oversight.

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

**Offline evaluation: precision@k, recall@k, and NDCG.** Before a
change to this kind of algorithm ships, you'd normally evaluate it
offline against historical data. The three metrics you will meet
first, stated precisely:

- **precision@k** — of the k items recommended, what fraction were
  relevant. Denominator is k.
- **recall@k** — of all the items that were relevant to this user,
  what fraction appeared in the top k. Denominator is the total number
  of relevant items.
- **NDCG@k** — normalized discounted cumulative gain, from Järvelin
  and Kekäläinen's 2002 paper. It is built in three steps, and
  informal write-ups routinely stop after step two.

NDCG is worth spelling out because getting it wrong is the norm.
**Cumulated gain** is just the sum of the relevance grades of the
first k results — it rewards retrieving relevant items but is
completely indifferent to their order. **Discounted** cumulated gain
divides each item's gain by a discount that grows with its rank
(conventionally `log2(rank + 1)`), so the same relevant item is worth
progressively less the further down the list it sits. That much is
what most descriptions cover, and by itself it is DCG, not NDCG. The
**normalized** step is the one that matters and the one usually
dropped: divide the DCG of the list you produced by the DCG of the
*ideal* list — the same items sorted perfectly, best-graded first —
so the result lands in 0..1. Without that division you cannot compare
scores across users at all, because a user with twenty relevant movies
will out-score a user with two on raw DCG no matter how good either
ranking was. NDCG is a ranking-quality measure; DCG is a
this-user-had-a-lot-of-good-options measure.

Use the truncated form, NDCG@k. Wang et al. showed that untruncated
NDCG over the whole list converges to 1 as the list grows, which means
it eventually stops distinguishing between ranking functions at all;
their analysis of which discount functions preserve distinguishability
is the reason `@k` is not just a convenience.

**Offline evaluation vs. online evaluation.** Offline metrics are
cheap and safe but can't measure "did showing this recommendation
change what the user actually did," which is what online A/B testing
measures directly, at the cost of being slow, expensive, and only
available on real traffic. Production recommenders use offline eval to
cheaply discard obviously bad candidates, then online A/B tests to
confirm the offline winner moves real behavior.

The important caveat is that offline metrics correlate imperfectly
with online outcomes, and this is documented rather than folklore.
Jannach and Jugovac's review of deployed systems is a direct critique
of "the value of algorithmic improvements and offline experiments as
commonly done in academic environments" precisely because they do not
reliably translate into measurable business effects. Netflix's own
account of the Netflix Prize is the canonical instance: the winning
Grand Prize entry — an ensemble of a hundred-plus blended predictors —
was never deployed. Netflix's stated reason is not that the ensemble
did not work; it is that "the additional accuracy gains that we
measured did not seem to justify the engineering effort needed to
bring them into a production environment," and that by the time the
prize concluded the company had moved to streaming, where predicting
what a member will *watch right now* mattered more than predicting the
star rating they would eventually give it. The offline metric was won.
The objective it stood in for had moved.

The practical consequence is that online measurement is the expensive
bottleneck, so mature teams invest in making it cheaper rather than in
trusting offline numbers more. Netflix's interleaving work is the
clearest published example: rather than A/B testing every candidate
ranker, they interleave two rankers' results in a single member's list
and observe which one's items get played, which they report needs
"greater than 100 times fewer subscribers to correctly determine
ranker preference" — then run a conventional A/B test on the small
surviving set to measure what interleaving cannot, namely retention.

**Where this would move next.** A pure genre-multiplier score does not
scale past a handful of categorical signals. The production-standard
shape, and the one to reach for first, is a two-stage pipeline:

1. **Retrieval.** A *two-tower* (dual-encoder) model — one tower
   encodes the user/context, one encodes the item, both into the same
   vector space — trained so that a dot product approximates
   relevance. Because the item tower does not depend on the user, every
   item's vector is precomputed offline into an index, and serving a
   request is one user-tower forward pass plus an **approximate
   nearest-neighbour** lookup (HNSW graphs, or a quantization-based
   index) over that index. That is what makes retrieval from tens of
   millions of items feasible in milliseconds, and it is what "reach
   for a vector store" actually means in practice: the vector store is
   the ANN index over the item tower's output, not a general-purpose
   embedding database bolted onto the side. Yi et al.'s Google paper is
   the standard reference and is also a warning — training on in-batch
   negatives silently biases the model toward popular items, and
   correcting that sampling bias is part of the design, not an
   optimization.
2. **Ranking.** A heavier model over the few hundred retrieved
   candidates, predicting the actual objective (watch, complete, rate
   highly). Logistic regression up through gradient-boosted trees or a
   neural ranker. The explicit rules in `rank.js` become input features
   to that model rather than the whole algorithm.

That two-stage cascade is still the default in 2026, but it is no
longer unchallenged, and it is worth knowing what the challenger is
before designing around the cascade as permanent. **Generative
retrieval** replaces "embed, then search an index" with "decode the
item's identifier directly." Each item is assigned a *semantic ID* — a
short tuple of discrete codewords derived from its content embedding,
so semantically similar items share prefixes — and a sequence model is
trained to emit the semantic ID of the next item a user will interact
with, given their history. The retrieval index disappears; the model's
parameters are the index. Rajput et al.'s TIGER introduced the
approach at NeurIPS 2023, and it has since left the lab: Kuaishou's
OneRec collapses the whole retrieve-then-rank cascade into a single
generative model and reports serving 25% of the app's queries per
second at roughly a tenth of the operating expense of the traditional
pipeline. Treat that as a live, contested direction rather than a
settled replacement — the cascade still serves the overwhelming
majority of production traffic industry-wide — but do not describe
two-tower plus ANN as the frontier, because it is now the baseline.

## Standard practice

- **The ranker is a pure function with no database and no Express** —
  one why: the entire scoring algorithm is unit-testable in
  milliseconds, with no test database setup, which is what makes rapid
  iteration on ranking rules practical.
- **Explicit signals outrank implicit ones (1.2/0.8 vs. 1.1)** — one
  why: weighting confidence by how the signal was collected prevents
  noisy, incidental behavior from swamping a deliberate user judgment.
  Deliberately simpler than best practice: the standard treatment
  separates an implicit observation into a binary preference and a
  confidence weight rather than compressing both into one multiplier.
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
  score sort and can be genre-homogeneous. No coverage or novelty
  measurement either, so there is nothing here that would even detect
  the problem.
- No offline evaluation harness (no precision@k/recall@k/NDCG@k
  computed anywhere in this codebase) and no online A/B testing
  infrastructure — both are described above as the real next steps,
  neither is implemented. There are also no relevance labels to compute
  them against: nothing records whether a recommendation was shown, let
  alone whether it was acted on.
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

## Further reading

Every link below was fetched and checked against what this README
claims. Where a paper sits behind a publisher that blocks automated
requests, the link points at a stable institutional or author record
of the same paper rather than a mirror.

**The field, end to end**

- [Recommender Systems Handbook, 3rd edition (Ricci, Rokach, Shapira, Springer 2022)](https://link.springer.com/book/10.1007/978-1-0716-2197-4)
  — the standard reference, and the one to check a taxonomy against
  before trusting a blog post. Its five parts cover the fundamental
  techniques, evaluation, and the beyond-accuracy material (fairness,
  novelty, diversity) that this README leans on.
- [Hybrid Recommender Systems: Survey and Experiments (Burke, UMUAI 12(4), 2002)](https://doi.org/10.1023/A:1021240730564)
  — where the hybrid taxonomy comes from. Read it for the vocabulary
  (weighted, switching, cascade, feature-augmentation hybrids), then
  read the "where this would move next" section above for why modern
  systems express those combinations as features in one model rather
  than as separately-wired subsystems.

**Signals and cold start**

- [Collaborative Filtering for Implicit Feedback Datasets (Hu, Koren, Volinsky, ICDM 2008)](http://yifanhu.net/PUB/cf.pdf)
  — the paper that makes the explicit/implicit distinction rigorous.
  Section 1 gives the cold-start trade quoted above; section 3 is the
  preference-vs-confidence split that this codebase's 1.1 multiplier
  stands in for. Short, and directly applicable.

**Evaluation, done properly**

- [Cumulated Gain-based Evaluation of IR Techniques (Järvelin & Kekäläinen, ACM TOIS 20(4), 2002)](https://researchportal.tuni.fi/en/publications/cumulated-gain-based-evaluation-of-ir-techniques/)
  — the origin of CG, DCG and NDCG. Worth reading in the original
  precisely because second-hand definitions so reliably drop the
  normalization step. (Record and DOI 10.1145/582415.582418 here; the
  ACM full text refuses automated fetches.)
- [A Theoretical Analysis of NDCG Type Ranking Measures (Wang et al., COLT 2013)](https://arxiv.org/abs/1304.6480)
  — why you should always write NDCG@k. Shows untruncated NDCG
  converges to 1 as the list grows and therefore stops distinguishing
  rankers, and characterizes which discounts avoid this.
- [Measuring the Business Value of Recommender Systems (Jannach & Jugovac, 2019)](https://arxiv.org/abs/1908.08328)
  — a survey of what deployed recommenders actually moved, and a
  pointed critique of treating offline accuracy gains as progress.
  This is the source for the "offline metrics correlate imperfectly
  with online outcomes" claim above.
- [Netflix Recommendations: Beyond the 5 Stars, Part 1 (Netflix TechBlog, 2012)](https://netflixtechblog.com/netflix-recommendations-beyond-the-5-stars-part-1-55838468f429)
  — the primary source for the Netflix Prize lesson: the Grand Prize
  ensemble was evaluated and not deployed, because the accuracy gain
  did not justify the engineering effort and the objective had moved
  from rating prediction to streaming consumption.
- [Innovating Faster on Personalization Algorithms at Netflix Using Interleaving (Netflix TechBlog, 2017)](https://netflixtechblog.com/interleaving-in-online-experiments-at-netflix-a04ee392ec55)
  — how a team that can afford proper online testing still tries to
  make it cheaper. Explains interleaving as a pruning stage before A/B,
  including what it cannot measure.

**Beyond accuracy**

- [Diversity, Serendipity, Novelty, and Coverage (Kaminskas & Bridge, ACM TiiS 7(1), 2016)](https://research.ucc.ie/en/publications/diversity-serendipity-novelty-and-coverage-a-survey-and-empirical/)
  — the survey that defines all four terms and measures how optimizing
  one affects the others. The reference to reach for before claiming a
  system is "diverse" or "serendipitous."
- [The Unfairness of Popularity Bias in Recommendation (Abdollahpouri et al., 2019)](https://arxiv.org/abs/1907.13286)
  — popularity bias measured rather than asserted, and framed as a
  fairness problem across user groups rather than only a long-tail
  coverage problem.
- [Exploring the Filter Bubble (Nguyen, Hui, Harper, Terveen, Konstan, WWW 2014)](https://experts.umn.edu/en/publications/exploring-the-filter-bubble-the-effect-of-using-recommender-syste/)
  — the individual-level measurement of content-diversity narrowing on
  MovieLens, including the counterintuitive finding that users who take
  the recommendations narrow less. Read this before repeating the
  popular version of the filter-bubble claim.

**What production actually looks like**

- [Sampling-Bias-Corrected Neural Modeling for Large Corpus Item Recommendations (Yi et al., RecSys 2019)](https://research.google/pubs/sampling-bias-corrected-neural-modeling-for-large-corpus-item-recommendations/)
  — the two-tower retrieval architecture as deployed at YouTube scale,
  and the sampling-bias correction that makes in-batch-negative
  training work without collapsing onto popular items.
- [Efficient and robust approximate nearest neighbor search using HNSW graphs (Malkov & Yashunin, 2016)](https://arxiv.org/abs/1603.09320)
  — the ANN index underneath the retrieval stage. Explains why
  "search a vector store" is logarithmic rather than a scan, which is
  the whole reason the two-tower split pays off.
- [Recommender Systems with Generative Retrieval (Rajput et al., NeurIPS 2023)](https://arxiv.org/abs/2305.05065)
  — TIGER, the semantic-ID approach that decodes item identifiers
  instead of searching an embedding index. The clearest statement of
  what the alternative to two-tower plus ANN actually is.
- [OneRec Technical Report (Kuaishou, 2025)](https://arxiv.org/abs/2506.13695)
  — generative retrieval past the paper stage: one model replacing the
  retrieve-then-rank cascade, reported at 25% of live queries per
  second and about a tenth of the pipeline's operating expense. Read it
  for the production constraints, not the benchmark numbers.

**Elsewhere in this monorepo**

- `../movies/README.md` — where `averageRating` comes from, and why the
  popularity feedback loop described above cannot close in this toy.
- `../notifications/README.md` — the other half of this app, and the
  place delivery semantics and idempotency are treated properly.
- `../../../../mern-tickets/server/src/policy/README.md` — a real
  authorization layer, for contrast with the `x-user-id` header this
  recommender trusts to identify the caller.
- `../../../../mern-shop/server/src/fraud/README.md` — the same
  "explainable score built from named, individually-testable signals"
  shape as `rank.js`, applied to fraud rather than relevance. Useful
  side-by-side reading on when a transparent rules engine beats a
  learned model.
