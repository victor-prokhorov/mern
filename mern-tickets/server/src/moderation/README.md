# Keyword blocking

## What this is

A keyword-matching layer that runs on every ticket and comment body before it is saved: text is normalized to defeat common evasion tricks, then matched against a database-backed list of terms, and the outcome is either a hard rejection, a silent flag for human review, or nothing at all.

## How it works here

The matching itself is not called directly from the ticket service any more — it runs as a hook handler. `keywordBlockerHandler` (`src/hooks/bootstrap.js:11`) loads every `BlockedTerm` from the database, calls `scan` (`src/moderation/keywords.js:42`), and returns `{ action: 'reject', reason: 'content rejected' }` if any match has `severity: 'block'` — which the hook pipeline turns into a 400 before anything is persisted (see `src/hooks/README.md` for the pipeline itself). Otherwise it returns `{ action: 'transform', payload: { ...payload, moderation: { flagged: true, terms: [...] } } }`, and that payload is what `create` and `addComment` (`src/services/tickets.js:42-51`, `src/services/tickets.js:108-113`) persist on the ticket or comment. This handler is registered on both `ticket:before-create` and `comment:before-create` by `registerModerationHooks` (`src/hooks/bootstrap.js:42`).

`scan(text, blockedTerms, allowlist)` (`src/moderation/keywords.js:42`) first runs `normalize` (`src/moderation/normalize.js:46`) over the input text, then splits it into words (`tokenize`, `src/moderation/keywords.js:5`). For each word: if it is in the allowlist, it is skipped outright (`src/moderation/keywords.js:51`); otherwise it is checked against a `Map` of exact normalized terms for `matchType: 'word'` (`buildWordIndex`, `src/moderation/keywords.js:9`), and walked through a character trie of `matchType: 'substring'` terms (`buildSubstringTrie` / `scanSubstringTrie`, `src/moderation/keywords.js:17-40`). Both structures are built once per call from whatever `BlockedTerm` rows exist, not looped per term per word.

`normalize` (`src/moderation/normalize.js:46`) composes five independently exported, independently testable steps, applied in this order: `toNFKC` (Unicode canonical-compatibility normalization, collapsing look-alike code points like the `ﬁ` ligature into `fi`), `stripZeroWidth` (removing zero-width space/joiner/no-break characters sometimes inserted mid-word to split a match), `toLowerCase`, `mapHomoglyphs` (character-by-character substitution of digits, punctuation, and Cyrillic look-alikes into their Latin equivalents — `0`, `1`, `3`, `4`, `5`, `7`, `@`, `$`, `!`, and Cyrillic `а`/`е`/`о`/`р`/`с`/`х`/`у`), and `collapseRepeats` (any run of two or more identical characters collapses to one, so `heeeello` and `hello` normalize to the same string). Both the stored term and the incoming text are normalized through the exact same pipeline before comparison, which is what makes the collapse step safe: a legitimately double-lettered blocked term collapses the same way the input does.

A flagged ticket or comment's real matched terms are only ever shown to a viewer whose role is `agent` or `admin`. `viewModeratable` (`src/controllers/tickets.js:7`) strips `moderation.terms` down to just `moderation.flagged` before any other role reads the response — including the reporter who submitted the content in the first place. The database record itself always keeps the full `terms` list; only the HTTP response is redacted, and only for a viewer who cannot act on the flag anyway.

## The core concepts

- **`text.includes(word)` is the wrong primitive**: it matches inside unrelated words (`Scunthorpe` contains `cunt`), it does nothing against elongation or leetspeak, and it is not the same operation as "does this text contain this word."
- **The evasion arms race**: any fixed matching rule invites a fixed workaround (letter-spacing, homoglyphs, zero-width insertion). Normalization closes specific channels; it does not close the arms race, which never ends.
- **Word boundaries and the Scunthorpe problem**: substring matching flags innocent words that merely contain a blocked string. `matchType: 'word'` requires the entire normalized token to equal the entire normalized term, which is why `scan('I grew up in Scunthorpe', [{ term: 'cunt', matchType: 'word' }])` returns no match while the same rule with `matchType: 'substring'` does.
- **False positives as a product cost**: an over-broad match doesn't just look silly, it makes a real reporter's real ticket disappear or bounce, which is why `matchType` is a per-term choice, not a global setting.
- **Severity tiers**: `block` (reject, nothing saved) and `flag` (save, mark, let a human decide) are different tools for different confidence levels. Treating every match as a hard block turns every false positive into a lost ticket, with no path to review.
- **Keyword lists as one layer, not a moderation strategy**: this catches known, literal strings. It catches nothing about tone, intent, or a bad-faith pattern spread across many messages. A real system layers this under/alongside a trained classifier, sender reputation, rate limits (see `src/throttle/README.md`), and human review — each catching what the others miss.
- **Allowlists**: an exact-word exemption list checked before term matching, so a word entirely composed of an allowlisted phrase (`assassin`) is never even tested against blocked substrings (`ass`). Precedence: allowlist beats every blocked-term match, at the whole-word level, with no partial exemption — the entire word has to match the allowlist entry, not merely overlap it.
- **Localization**: this pipeline normalizes case, spacing tricks, and a small hand-picked homoglyph table. It has no notion of language-specific stemming, non-Latin scripts as a first-class alphabet, or transliteration beyond the few Cyrillic look-alikes listed. A term list in English catches nothing in another language.
- **Auditability and appeal**: every flagged ticket or comment keeps its matched terms in `moderation.terms` in the database, so a reviewer can see exactly why it was flagged. A hard `block`, by contrast, is never stored at all — there is nothing to appeal because there is no record, which is a real tradeoff, not an oversight (see below).
- **Performance and DoS**: matching every message against every term with a nested loop is O(text length × term count) per request — an attacker (or just a large list) can make that arbitrarily slow. Building a `Map` for exact terms and a trie for substrings means the *matching* step against a given message is roughly linear in that message's length regardless of how many terms exist, because both structures are consulted once per word, not iterated per term — though building those structures still costs proportional to the term set's total size, and this implementation pays that cost on every call rather than caching it (see "What this toy skips").

## Standard practice

- Normalize both sides (stored term and incoming text) through the identical pipeline — normalizing only one side breaks the symmetry evasion techniques rely on being defeated.
- Default `matchType` choices to `word`, not `substring` — substring matching should be an opt-in for specific short strings a reviewer has actually decided are unsafe as any substring.
- Never tell the caller which term matched — the 400 body never names a term, and a flagged record's real terms are shown only to an agent or admin reviewing it, never to the reporter who submitted the content, because naming it hands an evader the next iteration of their bypass for free.
- Keep the term list and matching logic data-driven (`BlockedTerm` rows), not hardcoded strings in the matching code — a moderator should be able to add a term without a deploy.
- Build the matching structures once per scan from the current term set, not per term per message — this is the difference between linear and quadratic behavior as the term list grows.

## What this toy skips

- A rejected (`block`) submission leaves no record anywhere — there is no audit trail for what was blocked, unlike the `flag` path. A real system typically logs blocked attempts (without necessarily returning the term to the caller) so patterns of abuse are visible to operators even when no ticket exists to show for it.
- The allowlist is a hardcoded in-memory list (`ALLOWLIST` in `src/moderation/keywords.js:3`), not a `BlockedTerm`-style database collection a moderator can edit at runtime.
- No classifier, sender reputation, or rate-limit signal feeds into the decision here — this is purely a literal term list. See `src/hooks/README.md` for how this keyword blocker composes with a link-limit and duplicate-content check in one pipeline.
- No stemming or fuzzy matching beyond the specific evasions above (repeated letters, homoglyphs, zero-width characters) — plural forms, typos, or synonyms of a blocked term are not caught.
- The substring trie here restarts its walk at every character offset, so it is O(text length × longest term length), not the true O(text length + total term characters) a production Aho-Corasick implementation (with failure links) would give you. For keyword lists of realistic size this is fine; a list with many very long terms would want the real algorithm.
- The `Map`/trie are rebuilt from scratch on every `scan` call, from whatever `BlockedTerm` rows a fresh database query returns. Building them is proportional to the total size of the term set, so a very large term list still costs something on every single request even though the *matching* step against one message stays roughly linear in that message's length. A production system would cache the built structures and invalidate the cache when the term set changes, rather than rebuild per request.
- The allowlist is an exact-whole-word match: an entry for `assassin` suppresses the word `assassin` but not `assassins` or `assassinated` — plural and inflected forms are not covered unless they are also listed. A production allowlist would likely match a stem or a small set of common suffixes, not just the literal word.

## Try it

`npm run seed` creates three `BlockedTerm` rows (`src/seed.js`, `blockedTermSpecs`): `unacceptable` (`block`, word), `suspicious` (`flag`, word), and `ass` (`flag`, substring) — the last one exists specifically to exercise the allowlist, since `ALLOWLIST` (`src/moderation/keywords.js:3`) exempts `assassin`.

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
  -H 'x-user-id: <rae id>' -d '{"title":"t","body":"he is an assassin apparently","priority":"normal"}'
```
→ 201, and `moderation` is `{"flagged":false}` — `ass` would otherwise match as a substring of `assassin`, but the allowlist suppresses it.
