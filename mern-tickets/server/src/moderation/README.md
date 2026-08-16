# Keyword blocking

## What this is

A keyword-matching layer that runs on every ticket and comment body before it is saved: text is normalized to defeat common evasion tricks, then matched against a database-backed list of terms, and the outcome is either a hard rejection, a silent flag for human review, or nothing at all.

## How it works here

The matching itself is not called directly from the ticket service any more — it runs as a hook handler. `keywordBlockerHandler` (`src/hooks/bootstrap.js:11`) loads every `BlockedTerm` from the database, calls `scan` (`src/moderation/keywords.js:44`), and returns `{ action: 'reject', reason: 'content rejected' }` if any match has `severity: 'block'` — which the hook pipeline turns into a 400 before anything is persisted (see [`../hooks/README.md`](../hooks/README.md) for the pipeline itself). Otherwise it returns `{ action: 'transform', payload: { ...payload, moderation: { flagged: true, terms: [...] } } }`, and that payload is what `create` and `addComment` (`src/services/tickets.js:44-53`, `src/services/tickets.js:119-124`) persist on the ticket or comment. This handler is registered on both `ticket:before-create` and `comment:before-create` by `registerModerationHooks` (`src/hooks/bootstrap.js:42`).

`scan(text, blockedTerms, allowlist)` (`src/moderation/keywords.js:42`) first runs `normalize` (`src/moderation/normalize.js:46`) over the input text, then splits it into words (`tokenize`, `src/moderation/keywords.js:7`). For each word: if it is in the allowlist, it is skipped outright (`src/moderation/keywords.js:53`); otherwise it is checked against a `Map` of exact normalized terms for `matchType: 'word'` (`buildWordIndex`, `src/moderation/keywords.js:11`), and walked through a character trie of `matchType: 'substring'` terms (`buildSubstringTrie` / `scanSubstringTrie`, `src/moderation/keywords.js:19-42`). Both structures are built once per call from whatever `BlockedTerm` rows exist, not looped per term per word.

`normalize` (`src/moderation/normalize.js:46`) composes five independently exported, independently testable steps, applied in this order:

- `toNFKC` — Unicode Normalization Form KC, which UAX #15 defines as *compatibility decomposition followed by canonical composition*. That is what folds the `ﬁ` ligature into `fi` and full-width `ａ` into `a`. It is worth being precise about what this does not do: NFKC is not a look-alike or confusables mechanism, and it leaves Cyrillic `а` (U+0430) exactly where it found it. Compatibility mappings and visual confusability are two different Unicode concepts, handled by two different documents.
- `stripZeroWidth` — removes a fixed five-character class, U+200B zero-width space, U+200C zero-width non-joiner, U+200D zero-width joiner, U+2060 word joiner and U+FEFF zero-width no-break space (the BOM), any of which can be inserted mid-word to split a match. The general form of this step is UTS #39's removal of Default_Ignorable_Code_Point characters, which covers considerably more than five.
- `toLowerCase`.
- `mapHomoglyphs` — a hand-written 16-entry substitution table: the leetspeak digits and punctuation `0 1 3 4 5 7 @ $ !`, and the Cyrillic look-alikes `а е о р с х у`, each folded to a Latin letter. This is a miniature stand-in for UTS #39's `skeleton` algorithm over `confusables.txt`, and it differs from the real thing in kind, not just in size. `confusables.txt` maps each character to a *prototype* which is often not the Latin letter you would expect — it maps Cyrillic `б` to the digit `6` and Cyrillic `З` to the digit `3`, going the opposite direction from the digit-to-letter folding here — and it carries thousands of mappings across every script. A real deployment consumes that data file; it does not hand-write the table.
- `collapseRepeats` — any run of two or more identical characters collapses to one, so `heeeello` and `hello` normalize to the same string.

Both the stored term and the incoming text are normalized through the exact same pipeline before comparison. That symmetry is necessary, and it is not sufficient — see "Recall versus precision" below, which is the one thing to take away from this module.

`BlockedTerm` therefore refuses to store a `substring` term shorter than `MIN_SUBSTRING_TERM_LENGTH` (4) *measured after normalization* (`src/models/blockedTerm.js`, a `pre('validate')` hook; the constant lives in `src/moderation/keywords.js:5`). The check runs where a term is created or seeded rather than where it is matched, so a term that cannot be safe never reaches the database. The error names both the term and what it normalizes to, because the cases that surprise people are the ones that look long enough:

```
BlockedTerm validation failed: term: substring terms must be at least 4 characters
after normalization, and "hell" normalizes to "hel"
```

`word` terms are deliberately exempt from the floor: they match a whole token, so a three-letter word term matches the word and nothing else.

A second write-time rule guards a subtler dead end. `tokenize` (`src/moderation/keywords.js:7`) splits scanned text on non-alphanumerics, so no token ever contains a space or punctuation — which means a multi-word term (`buy now`) or a punctuated one (`e-mail`) could sit in the database forever without matching anything, silently. The same `pre('validate')` stage therefore also refuses any term that does not normalize to a single alphanumeric token, with the same shape of error naming the term and what it normalizes to.

A flagged ticket or comment's real matched terms are only ever shown to a viewer whose role is `agent` or `admin`. `viewModeratable` (`src/moderation/view.js:5-9`) strips `moderation.terms` down to just `moderation.flagged` before any other role reads the response — including the reporter who submitted the content in the first place. The database record itself always keeps the full `terms` list; only the HTTP response is redacted, and only for a viewer who cannot act on the flag anyway. It is shared, not controller-only: every controller response goes through it (`src/controllers/tickets.js:5-41`), and so does the one non-HTTP path that can return ticket state directly — the 412 conflict body a stale optimistic-concurrency write gets back (`src/services/tickets.js:85`, see [`../concurrency/README.md`](../concurrency/README.md)).

## The core concepts

- **`text.includes(word)` is the wrong primitive**: it matches inside unrelated words (`Scunthorpe` contains `cunt`), it does nothing against elongation or leetspeak, and it is not the same operation as "does this text contain this word."
- **The evasion arms race**: any fixed matching rule invites a fixed workaround (letter-spacing, homoglyphs, zero-width insertion). Normalization closes specific channels; it does not close the arms race, which never ends.
- **Word boundaries and the Scunthorpe problem**: substring matching flags innocent words that merely contain a blocked string. The name comes from an April 1996 incident in which AOL's profanity filter refused registrations from residents of Scunthorpe, Lincolnshire; the earliest widely circulated technical write-up is Clive Feather's item in RISKS Digest 18.07, 25 April 1996. `matchType: 'word'` requires the entire normalized token to equal the entire normalized term, which is why `scan('I grew up in Scunthorpe', [{ term: 'cunt', matchType: 'word' }])` returns no match while the same rule with `matchType: 'substring'` does. Both halves of that sentence were run against this code, not assumed. This is also what the seeded term list demonstrates: `cunt` is seeded as a `substring` term precisely so that `Scunthorpe` collides with it, and the allowlist is what rescues the town.
- **Recall versus precision, which is the trade every normalization step is making.** Each step in the pipeline widens the set of strings that count as "the same": `heeeello` reaches `hello`, `p@ssw0rd` reaches `password`, `unаcceptable` with a Cyrillic `а` reaches `unacceptable`. That is bought recall — evasions that would otherwise slip past now match. It is paid for in precision, and the bill lands entirely on short terms, because normalization applies to the *stored term* as well as the input. `collapseRepeats` shortens both sides. A term that is already short becomes shorter, and every character it loses roughly multiplies the number of innocent words it appears inside.
  This module shipped the failure before it shipped the fix, which makes it a good worked example rather than a hypothetical. The seed used to carry `ass` as a `substring` term. Normalized, it is `as` — two characters — and `password` normalizes to `pasword`, so the app flagged its own demo ticket. `case`, `glass` and `classic` went the same way. Nothing about the matching code was wrong; the term was unsafe at that length, and symmetric normalization could not make it safe, because symmetry preserves the *match* while the shortening destroys the *specificity*.
  The two standard mitigations are both in force here, and they are different tools:
  1. **A minimum length for substring terms, measured after normalization.** This is the mechanical guard, enforced at write time. Four characters is a floor, not a guarantee — a four-character substring term is still a substring term.
  2. **Prefer word matching by default.** This is the design guard, and the stronger of the two. `matchType: 'word'` is immune to the whole failure class, because it compares complete tokens: a short *word* term matches exactly that word. Substring matching should be a decision someone makes about a specific string, not the default the term list drifts into.
- **False positives as a product cost**: an over-broad match doesn't just look silly, it makes a real reporter's real ticket disappear or bounce, which is why `matchType` is a per-term choice, not a global setting. Severity compounds it: the `ass` incident above was survivable only because the term was seeded as `flag`. The identical mistake on a `block` term rejects legitimate tickets outright and, per the `block` path's design, leaves no record that it happened.
- **Normalization is lossy on purpose, and the standard says so**: UAX #15 warns that Normalization Forms KC and KD "must *not* be blindly applied to arbitrary text," because they erase formatting distinctions and can remove distinctions important to the meaning of the text. Applying NFKC to arbitrary user-submitted prose, as this pipeline does, is exactly the blind application it warns about. It is defensible here because the normalized string is used only for matching and the original is what gets stored — the rule to take away is that you normalize a *comparison copy*, never the record.
- **Severity tiers**: `block` (reject, nothing saved) and `flag` (save, mark, let a human decide) are different tools for different confidence levels. Treating every match as a hard block turns every false positive into a lost ticket, with no path to review.
- **Keyword lists as one layer, not a moderation strategy**: this catches known, literal strings. It catches nothing about tone, intent, or a bad-faith pattern spread across many messages. Industry practice, as documented in the Digital Trust & Safety Partnership's Best Practices Framework, is a stack: proactive automated detection where it is warranted, user reporting channels, queues and trained reviewers who make and implement decisions, and measurement of the whole thing — with the framework's 2025 revision explicitly cautioning that newer automated classifiers raise capacity but still need risk assessment rather than blanket trust. A term list is one input to the first of those layers. Alongside it here: rate limits (see [`../throttle/README.md`](../throttle/README.md)) and the duplicate-content and link-limit handlers in [`../hooks/README.md`](../hooks/README.md).
- **Allowlists**: an exact-word exemption list checked before term matching, so a word entirely composed of an allowlisted phrase (`scunthorpe`) is never even tested against blocked substrings (`cunt`). Precedence: allowlist beats every blocked-term match, at the whole-word level, with no partial exemption — the entire word has to match the allowlist entry, not merely overlap it. Note the allowlist is normalized through the same pipeline, so its entries are compared as normalized tokens. An allowlist is the escape hatch for the false positives a substring term produces anyway; it is not a substitute for choosing the term well, because it only ever exempts the collisions somebody already thought of.
- **Localization**: this pipeline normalizes case, spacing tricks, and a small hand-picked homoglyph table. It has no notion of language-specific stemming, non-Latin scripts as a first-class alphabet, or transliteration beyond the few Cyrillic look-alikes listed. A term list in English catches nothing in another language. UTS #39 has machinery this pipeline does not touch at all — mixed-script detection and restriction levels — which is how you catch "this word is written in three scripts at once" without enumerating every look-alike pair.
- **Auditability and appeal**: every flagged ticket or comment keeps its matched terms in `moderation.terms` in the database, so a reviewer can see exactly why it was flagged. A hard `block`, by contrast, is never stored at all — there is nothing to appeal because there is no record, which is a real tradeoff, not an oversight (see below). It is worth knowing what that silence would cost on a public platform. Under the EU Digital Services Act (Regulation (EU) 2022/2065), applicable in full since 17 February 2024, a provider of hosting services owes an affected user a clear and specific *statement of reasons* for a restriction imposed because content is illegal or breaches its terms — removal, disabling access, or demotion all count (Article 17) — and an online platform must offer a free internal complaint-handling system against such decisions for at least six months (Article 20), on top of notice-and-action mechanisms for reporting illegal content (Article 16). An internal support desk of this kind is almost certainly outside the DSA's scope; the point is that "reject silently and store nothing" is not merely an engineering shortcut in the general case, it is the shape of a decision a regulated platform has to be able to explain and reverse.
- **Performance and DoS**: matching every message against every term with a nested loop is O(text length × term count) per request — an attacker (or just a large list) can make that arbitrarily slow. Building a `Map` for exact terms and a trie for substrings means the *matching* step against a given message is roughly linear in that message's length regardless of how many terms exist, because both structures are consulted once per word, not iterated per term — though building those structures still costs proportional to the term set's total size, and this implementation pays that cost on every call rather than caching it (see "What this toy skips").

## Standard practice

- Normalize both sides (stored term and incoming text) through the identical pipeline — normalizing only one side breaks the symmetry evasion techniques rely on being defeated. But do not mistake symmetry for correctness: a normalization step that *shortens* strings makes short terms shorter and therefore broader, which symmetry does nothing to fix.
- Normalize a comparison copy, never the stored record — UAX #15's warning about compatibility forms is about exactly this, and this code gets it right by storing `outcome.payload.body` unchanged.
- Default `matchType` to `word`, not `substring`. This is the single highest-value rule in this document: word matching compares whole tokens and is structurally immune to the false-positive class that substring matching invites. Substring matching should be a decision made about one specific string, with a reason.
- Enforce term-quality rules where terms are *written*, not where they are matched. A validation at the point of creation fails once, loudly, in front of the person who can fix it; the same rule applied at match time fails silently on every request forever. Measure any length rule after normalization, since that is the string that actually gets compared.
- Consume the Unicode data files rather than hand-writing a homoglyph table — `confusables.txt` is versioned, covers every script, and is maintained by people who track new look-alikes as characters are added. A hand-written table is frozen the day it is written.
- Never tell the caller which term matched — the 400 body never names a term, and a flagged record's real terms are shown only to an agent or admin reviewing it, never to the reporter who submitted the content, because naming it hands an evader the next iteration of their bypass for free. This is in tension with the statement-of-reasons duty noted above; real platforms resolve it by explaining the *category* and the appeal route without publishing the matching rule.
- Keep the term list and matching logic data-driven (`BlockedTerm` rows), not hardcoded strings in the matching code — a moderator should be able to add a term without a deploy.
- Build the matching structures once per scan from the current term set, not per term per message — this is the difference between linear and quadratic behavior as the term list grows.

## What this toy skips

- The length floor is a blunt instrument. Four characters after normalization stops the worst of it and is not a correctness guarantee — `cunt` is exactly four characters and still needs `scunthorpe` on the allowlist. The floor is a guard rail; word matching is the actual answer.
- Indexing collapsed variants of a term, which is the other standard mitigation and the more precise one. Rather than forbidding short substring terms, you would apply `collapseRepeats` to the input only and index every collapsed and uncollapsed form of the term, so `ass` stays three characters on the term side while `aaassss` still matches on the input side. That keeps recall without spending precision, at the cost of a larger index and a more complicated build step.
- Any feedback loop from false positives. Nothing counts how often a term fires, how often a reviewer clears the flag, or which term is responsible — which is what would let an operator notice a bad term in production rather than in a code review.
- A rejected (`block`) submission leaves no record anywhere — there is no audit trail for what was blocked, unlike the `flag` path. A real system typically logs blocked attempts (without necessarily returning the term to the caller) so patterns of abuse are visible to operators even when no ticket exists to show for it, and — on a platform in scope of the DSA — so a statement of reasons and an appeal are possible at all.
- The allowlist is a hardcoded in-memory list (`ALLOWLIST` in `src/moderation/keywords.js:3`), not a `BlockedTerm`-style database collection a moderator can edit at runtime. The length floor on the other side *is* enforced in the database layer, so the two halves of the same decision live in different places.
- No classifier, sender reputation, or rate-limit signal feeds into the decision here — this is purely a literal term list. See [`../hooks/README.md`](../hooks/README.md) for how this keyword blocker composes with a link-limit and duplicate-content check in one pipeline.
- No stemming or fuzzy matching beyond the specific evasions above (repeated letters, homoglyphs, zero-width characters) — plural forms, typos, or synonyms of a blocked term are not caught.
- No mixed-script or restriction-level check. UTS #39's other half is deciding that an identifier or a token mixing scripts is suspicious *as such*, which catches homoglyph substitutions nobody has enumerated yet; `mapHomoglyphs` can only ever catch the seven Cyrillic characters someone thought of.
- The substring trie here restarts its walk at every character offset, so it is O(text length × longest term length), not the true O(text length + total term characters) an Aho-Corasick implementation (with failure links) would give you. Aho and Corasick's 1975 result is precisely that: building the machine costs time proportional to the sum of the keyword lengths, and the number of state transitions while scanning is *independent of the number of keywords*. For keyword lists of realistic size the naive walk is fine; a list with many very long terms would want the real algorithm.
- The `Map`/trie are rebuilt from scratch on every `scan` call, from whatever `BlockedTerm` rows a fresh database query returns. Building them is proportional to the total size of the term set, so a very large term list still costs something on every single request even though the *matching* step against one message stays roughly linear in that message's length. A production system would cache the built structures and invalidate the cache when the term set changes, rather than rebuild per request.
- The allowlist is an exact-whole-word match: an entry for `scunthorpe` suppresses `Scunthorpe` but not `Scunthorpe's` as a single token, and an entry for `assassin` would not cover `assassins` or `assassinated` — plural and inflected forms are not covered unless they are also listed. A production allowlist would likely match a stem or a small set of common suffixes, not just the literal word.
- The database round trip for `BlockedTerm` rows happens inside the hook pipeline's 50 ms handler budget. If Mongo is slow, the keyword blocker times out, the pipeline fails open, and content that would have been rejected is saved — see [`../hooks/README.md`](../hooks/README.md).

## Try it

`npm run seed` creates three `BlockedTerm` rows (`src/seed.js`, `blockedTermSpecs`): `unacceptable` (`block`, word), `suspicious` (`flag`, word), and `cunt` (`flag`, substring) — the last one exists specifically to exercise the allowlist, since `ALLOWLIST` (`src/moderation/keywords.js:3`) exempts `scunthorpe`. It is also exactly four characters after normalization, which is the floor, so it doubles as the boundary case for the rule below.

```
curl -s -X POST http://localhost:5001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"rae@tickets.test","password":"demo1234"}'
```

Take the `_id` from that response as `<rae id>` below.

```
curl -s -X POST http://localhost:5001/api/tickets -H 'Content-Type: application/json' \
  -H 'x-user-id: <rae id>' -d '{"title":"t","body":"this is unacceptable behavior","priority":"normal"}'
```
→ 400 `{"error":"content rejected"}`, and nothing is persisted.

```
curl -s -X POST http://localhost:5001/api/tickets -H 'Content-Type: application/json' \
  -H 'x-user-id: <rae id>' -d '{"title":"t","body":"this looks suspicious to me","priority":"normal"}'
```
→ 201, and the response's `moderation` is `{"flagged":true}` — the matched term is stored (see the "How it works here" note on `viewModeratable`) but never returned to the reporter.

```
curl -s -X POST http://localhost:5001/api/tickets -H 'Content-Type: application/json' \
  -H 'x-user-id: <rae id>' -d '{"title":"t","body":"I grew up in Scunthorpe","priority":"normal"}'
```
→ 201, and `moderation` is `{"flagged":false}` — `cunt` matches as a substring of `Scunthorpe`, but the allowlist suppresses it. This is the Scunthorpe problem and its escape hatch, in one request.

```
curl -s -X POST http://localhost:5001/api/tickets -H 'Content-Type: application/json' \
  -H 'x-user-id: <rae id>' -d '{"title":"t","body":"The password reset link is broken.","priority":"normal"}'
```
→ 201 with `moderation` `{"flagged":false}`. This one used to come back `{"flagged":true}`, and the story is in "Recall versus precision" above: the seed used to carry `ass` as a substring term, `ass` normalizes to `as`, `password` normalizes to `pasword`, and the substring matched. `case`, `glass` and `a classic bug` all did the same. Two practical notes for running these: only five ticket creations per user are allowed before the throttle steps in (and a `block` rejection still spends a token, because the throttle runs first), and the wording above deliberately differs from the seed's `Password reset link is broken.`, which the duplicate-content handler would reject with a 400 instead.

To watch the length floor reject a term, try to create one. Note that `hell` is four characters as typed and three after normalization, which is the case the rule exists for:

```
node --input-type=module -e '
import mongoose from "mongoose";
import { connect } from "./src/db.js";
import BlockedTerm from "./src/models/blockedTerm.js";
await connect("mongodb://127.0.0.1:27017/mern-tickets");
const owner = await mongoose.connection.collection("users").findOne({});
for (const spec of [
  { term: "ass", matchType: "substring" },
  { term: "hell", matchType: "substring" },
  { term: "ass", matchType: "word" },
  { term: "cunt", matchType: "substring" }
]) {
  try {
    const created = await BlockedTerm.create({ ...spec, severity: "flag", createdBy: owner._id });
    console.log("accepted:", JSON.stringify(spec));
    await BlockedTerm.deleteOne({ _id: created._id });
  } catch (err) {
    console.log("rejected:", JSON.stringify(spec), "->", err instanceof Error ? err.message : String(err));
  }
}
await mongoose.disconnect();'
```

```
rejected: {"term":"ass","matchType":"substring"} -> BlockedTerm validation failed: term: substring terms must be at least 4 characters after normalization, and "ass" normalizes to "as"
rejected: {"term":"hell","matchType":"substring"} -> BlockedTerm validation failed: term: substring terms must be at least 4 characters after normalization, and "hell" normalizes to "hel"
accepted: {"term":"ass","matchType":"word"}
accepted: {"term":"cunt","matchType":"substring"}
```

The matching functions are also easier to poke at directly than through HTTP. This is the old seed against the new one, side by side:

```
node --input-type=module -e '
import { normalize } from "./src/moderation/normalize.js";
import { scan, ALLOWLIST } from "./src/moderation/keywords.js";
const old = [{ term: "ass", severity: "flag", matchType: "substring" }];
const now = [{ term: "cunt", severity: "flag", matchType: "substring" }];
for (const s of ["The password reset link is broken.", "the glass broke", "a classic bug", "I grew up in Scunthorpe"]) {
  console.log(JSON.stringify(s), "->", JSON.stringify(normalize(s)),
    "old:", scan(s, old, ALLOWLIST).map((t) => t.term),
    "now:", scan(s, now, ALLOWLIST).map((t) => t.term));
}'
```

## Further reading

The Unicode entries are the ones to read first: almost every wrong claim in moderation write-ups is a Unicode claim.

- [UAX #15, Unicode Normalization Forms](https://www.unicode.org/reports/tr15/) — the definition of NFD/NFC/NFKD/NFKC in one table, and the explicit warning that the K forms must not be blindly applied to arbitrary text. If you only ever read one section, read the table and the warning.
- [UTS #39, Unicode Security Mechanisms](https://www.unicode.org/reports/tr39/) — confusables, the `skeleton` algorithm, mixed-script detection and the six restriction levels. This, not NFKC, is the standard for look-alike attacks, and the mixed-script half is the part hand-rolled homoglyph tables can never reach.
- [`confusables.txt`, Unicode Security Data (current version)](https://www.unicode.org/Public/security/latest/confusables.txt) — the actual data file. Skim it once to see how large the real mapping is and how often the prototype is not the character you would have guessed.
- [Clive Feather, "AOL censors British town's name!", RISKS Digest 18.07, 25 April 1996](https://catless.ncl.ac.uk/Risks/18.07) — the primary record of the Scunthorpe incident, in the newsgroup where it was first widely reported. Three sentences, and it settles the attribution.
- [Aho and Corasick, "Efficient String Matching: An Aid to Bibliographic Search", CACM 18(6), 1975](https://cr.yp.to/bib/1975/aho.pdf) — the algorithm this module's trie approximates. The abstract states the complexity result exactly: construction proportional to the sum of keyword lengths, scanning cost independent of the number of keywords.
- [Digital Trust & Safety Partnership, Best Practices Framework (2025)](https://dtspartnership.org/wp-content/uploads/2025/07/DTSP_Best_Practices_Framework_2025.pdf) — what a moderation stack looks like when written down by the people operating them: product governance, enforcement operations, reviewer queues, and measurement. Useful as the honest scope check on any single-technique write-up, including this one.
- [Regulation (EU) 2022/2065, the Digital Services Act](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022R2065) — read Articles 16, 17 and 20 together: notice and action, statement of reasons, and the free internal appeal route. They are short, and they are the concrete legal form of "a decision you cannot explain or reverse is a defect."
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) — for the missing-record problem on the `block` path: which events are worth recording, and why an audit trail is kept separate from application logs.

Elsewhere in this repo: [`../hooks/README.md`](../hooks/README.md) for the pipeline this handler runs inside and the fail-open behaviour that can silently skip it; [`../throttle/README.md`](../throttle/README.md) for the rate-limit layer that sits beside a term list; [`../../../../mern-shop/server/src/fraud/README.md`](../../../../mern-shop/server/src/fraud/README.md) for the same allow / review / refuse tiering applied to orders rather than text, with an explainable score instead of a term match; [`../../../../mern-shop/server/src/blocklist/README.md`](../../../../mern-shop/server/src/blocklist/README.md) for pattern matching against accounts rather than content.
