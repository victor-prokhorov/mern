# Mutation testing

## What this is

A hand-rolled mutation testing runner: it takes a source file, makes one small
semantic change to it at a time (flip a comparison, swap `&&` for `||`, drop an
`await`, empty a function body), runs the app's real test suite against that
one change, and records whether the suite noticed. A suite that fails is a
"kill" — something depended on the code behaving the way it used to. A suite
that stays green on genuinely broken code is a "survivor" — proof that nothing
in the suite actually checks that behavior, no matter what the coverage report
says. This is the technique that, run by hand earlier in this repo's history,
caught four real defects that full green suites had missed: a scoping guard
that survived deletion, a rolling window replaced by a counter that never
forgets, a shutdown-ordering test that could not tell two orders apart, and an
`AsyncLocalStorage` context replaced by a module-level variable. This tool
makes that repeatable instead of artisanal.

## How it works here

1. `cli.js:22` (`main`) parses `--app`, `--files`, `--max`, `--seed`, `--out`
   and `--timeout`, resolves the app to a root directory and test command via
   `apps.js:7` (`APPS`), and either uses the given `--files` list or walks the
   app's `src/` with `discover.js:6` (`discoverSourceFiles`), which skips
   `node_modules`, `test`/`tests` directories and anything ending in
   `.test.js`.
2. `run.js:88` (`assertCleanGitState`, called from `runMutationTesting`) shells
   out to `git status --porcelain -- <files>` before touching anything, and
   refuses to start if any target file is already dirty — the one case that
   makes this true is a previous run that crashed mid-mutation and left a
   mutated file on disk, and starting a new run on top of that would silently
   treat the mutation as "the original".
3. For each target file, `lexer.js:1` (`computeMutableMask`) walks the source
   character by character with a small state machine (`code`, line comment,
   block comment, single- and double-quoted string, template literal —
   including one level of `${...}` interpolation — and regex literal) and
   produces a same-length mask marking which bytes are real code versus string
   or comment content. Every mutator in `operators.js` checks
   `lexer.js:176` (`isMutableSpan`) before proposing a match, so a `<=` typed
   inside a log message or a comment is never touched.
4. `operators.js` finds candidate mutations with regexes scoped to the mask:
   `comparisonFlip` (`operators.js:26`) flips `<`↔`<=`, `>`↔`>=`, `===`↔`!==`;
   `logicalSwap` (`:53`) swaps `&&`↔`||`; `negateCondition` (`:72`) wraps an
   `if (...)` condition in `!(...)` by counting parens to find the matching
   close; `removeAwait` (`:106`) deletes an `await ` keyword; `numericLiteralShift`
   (`:123`) adds one to an integer literal; `returnValueReplace` (`:141`)
   replaces a `return EXPR` with `null`/`undefined`/`true`/`false` (skipping
   the case where `EXPR` already trivially is one of those, since mutating
   `return null` to `return null` changes nothing); and `emptyFunctionBody`
   (`:162`) matches a function/arrow/getter/setter/constructor head, finds the
   matching closing brace by depth-counting only mask-mutable braces, and
   empties the body (skipping bodies that are already empty). `findAllMutants`
   (`:194`) runs all seven and returns every candidate sorted by position —
   deliberately not deduplicated against each other, because each mutant is
   applied and tested in isolation, so two mutators finding overlapping spans
   in the same function is not a conflict.
5. `mutate.js:13` (`buildMutantList`) assigns each candidate a stable id
   (`file::operator::line::index`) using a seeded RNG (`random.js:1`,
   `seededRng`, a mulberry32-style generator seeded by hashing the `--seed`
   string) so the same seed always produces the same mutant list in the same
   order, and `random.js:22` (`shuffleInPlace`) does a seeded Fisher-Yates
   shuffle before `run.js` caps the list at `--max` — the cap is a random
   sample across every candidate and every file, not just the first N found.
6. `run.js:106` loops over the capped list. For each mutant not already present
   in the results file (the resume check, `run.js:108`), it writes the mutated
   source over the real file, records `{ abs, original }` in the module-level
   `activeRestore` (`run.js:8`, `:118`), and runs the app's test command with
   `runTestCommand` (`:50`), which uses async `child_process.spawn` (not
   `spawnSync`) specifically so a `SIGINT`/`SIGTERM` handler
   (`handleInterrupt`, `:18`) can kill the in-flight child and unblock the
   `await` — see "what this toy skips" for why that distinction mattered in
   practice. The `finally` block (`:138`) always restores the original file
   content before the loop moves on, whether the suite passed, failed, timed
   out, or crashed.
7. Status is `survived` (exit code 0 — the suite didn't notice), `killed`
   (non-zero exit, or a hard timeout — `run.js:127`, a wedged mutant that
   leaves an Express handler never calling `next()` is treated as a kill, not
   a hang, since a suite that never returns is a failed suite), or `error`
   (the test command itself couldn't run). Every result is appended to the
   results map and the whole map is rewritten to `--out` after each mutant
   (`writeResults`, `:44`), so a run can be `Ctrl-C`'d or crash and resumed
   later with the same `--seed`/`--out` and pick up exactly where it left off.
8. `report.js` (`summarize`, `formatReport`) turns the results into a
   mutation score per file and a flat survivor list; `cli.js` prints it and
   also leaves the full JSON on disk for the audit in this PR to read back.

## The core concepts

- **Mutation score is not line coverage.** Coverage answers "did this line
  run"; mutation score answers "if this line were wrong, would something
  fail." A file at 100% line coverage can be at 0% mutation score if every
  assertion only checks that a call didn't throw. Coverage is a precondition
  for mutation testing to be worth running at all — PIT's own docs note that
  mutating uncovered lines is wasted work because "all of which would
  inevitably survive" — but it is a lower bound on nothing about correctness.
- **Equivalent mutants, and why detecting them is undecidable.** Some
  mutations produce code that behaves identically to the original for every
  possible input — a `for (i = 0; i < n; i++)` that becomes `i <= n` for a
  loop whose body already breaks on the same condition, for instance. No test
  can ever kill an equivalent mutant, and telling one apart from a real gap
  in general is exactly the halting problem — Jia and Harman's survey
  attributes the proof to Budd and Angluin. A perfect mutation score is
  therefore neither achievable (some mutants are equivalent) nor desirable to
  chase (chasing it wastes review time telling equivalents apart from real
  gaps instead of writing the one assertion that was actually missing). This
  is exactly why `returnValueReplace` and `emptyFunctionBody` here skip the
  cheaply-detectable equivalent cases (a return that's already `null`, a body
  that's already empty) rather than generating them and asking a human to
  notice — PIT's own mutator design does the same thing deliberately, noting
  that its `NonVoidMethodCall` mutator "may create equivalent mutations if it
  replaces a method that already returns one of the default values."
- **The cost problem, and how real tools control it.** A suite with a 12
  second run time and 90 mutants is 18 minutes of wall clock for one file
  set — this repo's own `mern-shop` run. Real tools spend most of their
  engineering on making that number tractable, and this toy uses almost none
  of their tricks. Stryker's incremental mode stores a JSON report of which
  mutants each test previously killed and, on the next run, does "a
  git-like diff of your code and test files" to skip mutants whose code and
  covering tests haven't changed. mutmut tracks which tests exercise which
  function so each mutant runs only its relevant subset instead of the whole
  suite. Google's mutation testing at 2-billion-line scale works only because
  it mutates just the lines touched in a code review, filters mutants
  "likely to be irrelevant to developers," and selects mutators by their
  historical kill-rate, producing "orders of magnitude fewer mutants" than
  mutating everything. This tool does none of that: it always runs the full
  suite, for every mutant, with no coverage map telling it which tests could
  possibly be affected — `--files` and `--max` are the only cost controls,
  and they are blunt instruments (a random sample, not a targeted one).
- **Where mutation testing belongs in a pipeline.** Practitioner consensus
  converges on three tiers, not one: an incremental/diff mode scoped to the
  files a pull request actually touched, fast enough (minutes, not hours) to
  gate the PR itself; a full run against the main branch on a schedule
  (nightly or weekly) that is allowed to take hours and reports to a
  dashboard instead of blocking anyone; and, for some teams, one more full
  run as a pre-release gate. Running the full suite on every commit is the
  option nobody recommends, because the cost is `(full suite runtime) ×
  (mutant count)` — a 30 second suite with 500 mutants is a four-hour job.
  This repo's audit runs are closer to the nightly tier: capped, seeded,
  concentrated on the highest-value files, and meant to be read by a human
  afterward, not gate anything automatically.
- **What Stryker, PIT and mutmut give you over this.** All three parse a
  real AST for their target language, so their mutators cannot be confused
  by a template literal or a method-shorthand object property the way a
  regex-and-mask scanner can be (see below). All three integrate with the
  language's coverage tooling to run only the tests that could see a given
  mutant, instead of the whole suite. All three ship mutator catalogues far
  past what's here (PIT's `DEFAULTS` group alone is 11 mutators, with
  `STRONGER` and `ALL` groups beyond that) plus per-project config to exclude
  files, annotate an equivalent mutant as accepted, and track score over time.
  None of that is reachable from three dependency-free files in an evening;
  that tradeoff is the point of this repo's house rule against dependencies.
- **The honest limit: this finds weak assertions, not missing requirements.**
  A surviving mutant proves a test exists that exercises the mutated line but
  doesn't check the outcome the mutation changed — that's a weak assertion,
  and it's exactly what this tool is for. It cannot tell you that a
  requirement was never captured as a test at all — if nothing calls a
  function under any circumstance, there is no mutant survival to notice,
  because there was never a passing test to begin with. Mutation testing
  audits the tests you have; it has no opinion on the tests you never wrote.

## Standard practice

- Run mutation testing where coverage is already high — mutating uncovered
  code produces guaranteed, uninformative survivors and wastes the run.
- Treat the score as a diagnostic to investigate, not a target to hit —
  chasing 100% burns review time on equivalent mutants instead of on the one
  real gap in the batch.
- Scope routine runs to the diff (changed files, changed lines) and push full,
  whole-codebase runs to a nightly or pre-release job — the cost model is
  multiplicative in suite runtime and mutant count, so this is the single
  biggest lever available.
- Wire in coverage-aware test selection wherever the language tooling
  supports it (Stryker's `coverageAnalysis: perTest`, mutmut's per-function
  test tracking) — running only the tests that could see a given mutant is
  routinely an order-of-magnitude speedup over running the whole suite.
- Let mutants be silenced deliberately and visibly (a pragma, a config
  exclude list) rather than silently — an accepted equivalent mutant should
  be recorded as a decision, not just absent from the report.
- Seed and record the run configuration for anything sampled, so a reported
  score is reproducible and a survivor can be looked up again later.
- Restore the original source unconditionally after every mutant, including
  on crash or interrupt — a mutation testing tool that can leave a broken
  mutant checked into the working tree is worse than not running one.

## What this toy skips

- **No real parser.** Mutation sites are found with regexes over a
  string/comment mask, not an AST. This works for this codebase's actual
  style (explicit `function` keywords, arrow functions, no method shorthand
  in object literals) but a bare ES6 method-shorthand definition
  (`{ foo() { ... } }` with no `function`/`get`/`set`/`constructor` keyword)
  is invisible to `emptyFunctionBody`'s regex, and nested `${ {a:1} }` braces
  inside a template interpolation are not specially handled beyond one level
  of depth-counting.
- **No coverage-guided test selection.** Every mutant runs the app's entire
  suite. There is no map from "this line" to "these tests," so a change deep
  in `fraud/signals.js` reruns all 122 of `mern-shop`'s tests, not just the
  handful that actually exercise it.
- **No incremental mode.** Nothing here remembers that a mutant survived
  last week and the covering test hasn't changed since; every invocation
  starts from the full candidate list for the given files (modulo the
  `--out` resume, which only skips mutants already run in *this* results
  file, not across separate runs with different seeds or file sets).
- **No automatic equivalent-mutant detection beyond the cheapest cases.**
  `returnValueReplace` and `emptyFunctionBody` skip the trivially-equivalent
  case (mutating to the same value, emptying an already-empty body); nothing
  else here tries to prove two versions of a function are behaviorally
  identical, because in general nothing can — see "core concepts" above.
  Every other survivor needs a human to bucket it.
- **A real, if narrow, kill-window during an in-flight mutant.** `run.js`
  restores the original file in a `finally` block and additionally kills the
  active child process on `SIGINT`/`SIGTERM` so the `await` unblocks and that
  `finally` still runs — built specifically after testing this tool by
  sending `SIGTERM` to the parent process while a mutant was running: with a
  synchronous `child_process.spawnSync`, the signal handler could not run
  until the already-spawned child exited on its own, so the mutated file
  stayed on disk after the "interrupted" process. Switching to async `spawn`
  with a tracked child handle closed that gap for `SIGINT`/`SIGTERM`, but a
  `SIGKILL` to the runner itself still bypasses all JS-level cleanup — the
  `assertCleanGitState` preflight check exists as the second line of defense
  for exactly that case, refusing to start over a dirty file rather than
  silently adopting it as "the original."
- **No mutant sampling by historical usefulness.** `--max` takes a uniform
  random sample (via the seeded shuffle) across every candidate mutant.
  Real tools weight this by which mutation operators have historically been
  worth running, or by which lines a diff actually touched; this tool has no
  history to weight by.
- **No dashboard, no trend over time, no CI wiring.** Output is one JSON
  file and a text summary. Comparing today's score to last month's is a
  manual `diff`, not a feature.
- **JavaScript/Node only**, and only the seven operators listed above — no
  mutation of exception types, no mutation of object/array literals, no
  statement-deletion beyond a whole function body.

## Try it

Run the seven-operator catalogue against a single small file with a capped,
seeded sample — this is a real run against this repo's own
`mern-shop/server/src/middleware/auth.js`:

```bash
cd tools/mutation
node cli.js --app mern-shop --files src/middleware/auth.js --max 20 --seed demo
```

```
mutation testing: app=mern-shop files=1 seed=demo max=20
  [run ] src/middleware/auth.js:7 logical-swap -> killed
  [run ] src/middleware/auth.js:7 negate-condition -> killed
  [run ] src/middleware/auth.js:4 empty-function-body -> killed
  [run ] src/middleware/auth.js:5 logical-swap -> killed
  [run ] src/middleware/auth.js:7 comparison-flip -> killed

Mutation score per file:
  src/middleware/auth.js: 100.0% (5/5 killed, 0 survived, 0 error)
Overall: 100.0% (5/5 killed)

results written to .../mern-shop/server/.mutation-results.mern-shop.json
```

Every mutant here died, which is what a well-covered five-line middleware
should look like. Point it at a larger file and a bigger `--max` to see a
survivor — `mern-tickets/server/src/circuitBreaker/breaker.js` has several
numeric-literal defaults (`windowMs`, `openMs`, `halfOpenMaxCalls`) that
survive because no test pins their exact value, only the behavior around it:

```bash
node cli.js --app mern-tickets --files src/circuitBreaker/breaker.js --max 40 --seed demo2
```

Interrupt a run partway through (`Ctrl-C`) and rerun the identical command —
the same `--seed` and `--out` will skip every mutant already recorded and
continue from where it stopped, and `git status` will show a clean tree
either way.

## Further reading

- [Mutation testing — Wikipedia](https://en.wikipedia.org/wiki/Mutation_testing) — the mutation-score formula (`killed / total`), the competent programmer hypothesis, the coupling effect, and the definition of an equivalent mutant, in one place.
- [An Analysis and Survey of the Development of Mutation Testing (Jia & Harman, IEEE TSE 2011)](https://www.researchgate.net/publication/220069671_An_Analysis_and_Survey_of_the_Development_of_Mutation_Testing) — the field's own history of itself; the equivalent-mutant problem's undecidability (via Budd and Angluin) is discussed here as one of the two open problems that kept mutation testing out of mainstream practice for three decades.
- [Practical Mutation Testing at Scale (Petrović & Ivanković, Google, 2021)](https://arxiv.org/abs/2102.11378) — how a 2-billion-line codebase makes this affordable at all: mutate only the diff shown in code review, filter mutants "likely to be irrelevant to developers," and select mutators by historical kill-rate to get "orders of magnitude fewer mutants."
- [Stryker: Incremental mode](https://stryker-mutator.io/docs/stryker-js/incremental/) — the concrete mechanics of diffing a previous run against the current code and test files to decide which mutants are safe to skip.
- [PIT: Java Mutation Testing Systems](https://pitest.org/java_mutation_testing_systems/) — the cost problem stated plainly for a bytecode mutation system, and why earlier, slower tools like Jumble couldn't "provide a view on the effectiveness of a whole test suite" at any real scale.
- [PIT: Mutators](https://pitest.org/quickstart/mutators/) — why specific mutators are excluded from the default set for generating too many equivalent mutations, and the `DEFAULTS`/`STRONGER`/`ALL` group split this tool has no equivalent of.
- [mutmut documentation](https://mutmut.readthedocs.io/en/latest/) — a Python mutation tool with the two features this one lacks most: per-function test-relevance tracking to avoid running the whole suite per mutant, and a stop-and-resume workflow this tool's `--out` resume is a much cruder version of.
- [Mutation testing takes 4 hours. How do teams actually use it in CI? (autotomy.dev)](https://autotomy.dev/blog/mutation-testing-takes-4-hours-how-do-teams-actually-use-it-in-ci/) — the three-tier pipeline pattern (incremental on PRs, full nightly, gate before release) and the concrete cost numbers behind why nobody runs the full suite on every commit.
- [Finding Your Missing Tests With Mutation Testing (LMAX Technology)](https://technology.lmax.com/posts/finding-your-missing-tests-with-mutation-testing/) — a practitioner's account of the weak-assertion pattern this whole tool exists to surface: a surviving mutant most often means an assertion that never checked the value that changed, not a missing test case.
- [`../../mern-tickets/server/src/circuitBreaker/README.md`](../../mern-tickets/server/src/circuitBreaker/README.md) — the circuit breaker this file's own audit found several numeric-literal survivors in; read together with this file's report to see which of those are real gaps versus untested-but-inconsequential defaults.
- [`../../mern-tickets/server/src/throttle/README.md`](../../mern-tickets/server/src/throttle/README.md) — the rolling-window token bucket referenced in "what this is" above, whose replacement by a counter-that-never-forgets is the canonical example of a bug that a green, well-covered suite did not catch.
