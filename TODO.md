# TODO

Current phase: **Phase 2 — Reading aids**

## Weekend 1 tasks (in order)

1. [x] Generate real `data/verbiste.json` from Verbiste XML (~7000 verbs) via `scripts/build-verbiste.js`
2. [x] Add lemmatization to `background/conjugation.js` (selecting "mangeons" resolves to "manger")
3. [x] Add `getContextSentence(range)` in `content-script.js`; wire into `SAVE_WORD` flow
4. [x] Refactor `vocab` storage to per-URL keying; write one-time migration in `onInstalled`
5. [x] Add cursor-follow mode (click-to-translate default; hover-with-delay as reveal option)
       — superseded in Phase 2 testing: the reticle preview was removed and
       click-to-translate is now always on; see Phase 2 task 7 below.
6. [x] Add `background/cache.js` (7d TTL, 5000 entry cap); route `TRANSLATE` through it
7. [x] Add three placeholder icon PNGs at `icons/icon-{16,48,128}.png` (via `scripts/generate-icons.js`)

## Design-review follow-ups (2026-07-27) — do these before Phase 2

Ordered by impact. Phase 1 code is written but has never been run in a browser.

1. [x] `git init` — done
2. [x] Load unpacked in Chrome and read a real French article for 30 min —
       done to an extent; keep an eye out for issues below that only surface
       under more/longer real-world use.
3. [x] Detect language from `contextSentence`, not the bare word
       (`background/detect-lang.js`)
4. [x] Decided + implemented: switched to Chrome's built-in on-device
       Translator API (`background/offscreen.js`), dropped DeepL/Google.
       `minimum_chrome_version` now 138. DeepL API Free was also confirmed
       discontinued for new signups as of mid-2026, independent of this
       choice — the old path wasn't viable to keep anyway.
5. [x] Performance/correctness debt:
   - [x] `conjugation.js` rebuilds a 256K-entry index on every service-worker
         wake (~550ms, 76MB). Precomputed + sharded at build time
         (`data/verbs/<letter>.json`, `data/lemmas/<letter>.json`) — worst-case
         cold-start lookup measured at ~38ms vs ~550ms, byte-for-byte identical
         results verified against the old monolithic output (7011 infinitives +
         513-sample of 256K surface forms, 0 mismatches).
   - [x] `cache.js` rewrote all 5000 entries per miss. Now per-key storage
         (`tc:<hash>`), O(1) writes, periodic eviction via `alarms` (found and
         fixed a real bug along the way: millisecond-resolution timestamps tie
         under rapid writes, and a naive sort evicted newer entries instead of
         older ones under those ties — fixed with a monotonic per-write
         sequence folded into `ts`).
   - [x] Normalized URLs before using them as `vocab` keys (`lib/normalize-url.js`)
         — strips tracking params (`utm_*`, `fbclid`, `gclid`, ...), `#fragment`,
         trailing slash, lowercases host; keeps real content params like `?id=`.
         One-time migration re-buckets existing entries.
6. [x] Redesign vocab/SRS schema **before** Phase 3 writes data into it.
       Split into `vocab[url]` (occurrences, no SRS fields) and `cards[lemma]`
       (Leitner state + display fields + `occurrenceIds` back-pointers).
       `conjugation.js#resolveLemma()` collapses verb forms onto their
       infinitive; everything else falls back to its own normalized surface
       form (case-folded, accents preserved). One-time `migrateVocabToCards()`
       backfills `cards` from existing occurrences. Phase 3 still needs to:
       wire `RECORD_REVIEW`/`GET_DUE_REVIEWS` through `background/srs.js`
       (currently just the box→interval table + `dueAtForBox`), and add
       promote/demote logic on review.
7. [x] Manifest/doc hygiene:
   - [x] Drop unused permissions: `contextMenus`, `scripting` (`alarms` is now
         used by the cache eviction sweep — no longer unused), and the
         `en.wiktionary.org` host permission — confirmed unused via grep,
         removed from manifest.json
   - [x] Remove the `web_accessible_resources` block — done as part of the
         verbiste sharding work above (verified via Chrome's own docs that the
         service worker never needed it: "only pages or scripts loaded from an
         extension's origin can access that extension's resources," and the
         service worker already runs in that origin)
   - [x] Reconcile CLAUDE.md with reality:
         - `SAVE_VERB` was documented but sidepanel.js wrote `verbs` to
           storage directly. Added a real handler in service-worker.js and
           routed sidepanel.js's save-to-workbook button through it.
         - `GET_DUE_REVIEWS`/`RECORD_REVIEW` are still genuinely unimplemented
           (no review UI or Leitner scheduling logic exists yet) — annotated
           in CLAUDE.md as Phase 3/not-yet-wired rather than built out now.
         - `hoverModeEnabled`/`cursorFollowMode` were top-level storage keys;
           moved into `config` across service-worker.js, content-script.js,
           and popup.js (with a one-time migration folding in any existing
           top-level values), matching what CLAUDE.md already documented.
         - Side panel still reads/writes `vocab`/`cards` storage directly for
           rendering and delete — left as-is, out of scope for this pass.
   - [x] Move the Google API key out of the URL query string — moot: Google/
         DeepL are gone entirely (see #4), no API key exists anymore

## Phase 2 tasks

1. [x] Data pipeline: `scripts/build-lexicon.js` converts `data/Lexique4/Lexique4.tsv`
       (Lexique.org, 189,864 rows, user-provided) into `data/lexicon/<letter>.json`
       (top 30k surface forms by frequency, sharded like verbs/lemmas). Extracted
       shared `normalize()`/`shardKeyOf()`/`writeSharded()` into
       `scripts/shard-writer.js`; re-ran `build-verbiste.js` after the refactor
       and diffed `data/verbs/`/`data/lemmas/` — byte-identical.
2. [x] `data/cognates.json` — hand-curated ~360-entry French→English cognate map
       (not scripted; no reliable way to derive true cognates from frequency/POS
       data alone).
3. [x] `background/lexicon.js` — shard-cache loader mirroring `conjugation.js`;
       `lookupWord`/`lookupWords`/`lookupCognate`/`annotateWords`.
4. [x] `LOOKUP_WORDS` message added; `saveWord()` now fills `pos`/`gender`/`plural`
       on vocab occurrences/cards via lexicon lookup — those fields existed since
       Phase 1 but nothing populated them until now.
5. [x] `content/annotator.js` — page-wide word scan (TreeWalker, idle-chunked),
       one batched `LOOKUP_WORDS` per scan, span-wrapping for color-coding/
       dimming/cognate underline, `MutationObserver` for dynamic content,
       `chrome.storage.onChanged` for live cross-tab config, per-page CEFR
       estimate (frequency-rank banding only — v1 deliberately ignores
       known-vocab/review history, see CLAUDE.md's message contract note).
6. [x] Popup UI: color-coding toggle + 4 pickers, dimming/cognate toggles,
       reading-level readout (`GET_PAGE_LEVEL`, sent popup → content script
       directly).
7. [x] Loaded unpacked and tested in a real browser — found and fixed two
       real-world issues:
       - The cursor-follow reticle (grey word-under-cursor indicator, a
         Weekend-1 feature) didn't actually translate anything and existed
         only as a "click here" preview — removed entirely. Click-to-translate
         is now always on (no toggle), hover-dwell is the only remaining
         mode toggle, purely additive on top of click. Fixed a real bug in
         the process: hover mode's dwell timer didn't check whether a
         drag-selection was in progress, so it kept popping up single-word
         bubbles while the user was trying to select a multi-word phrase —
         now suppressed via mousedown/mouseup tracking.
       - Added a "📖 Workbook" button to the translation bubble and per-
         category (masculine/feminine/plural/neutral) enable checkboxes next
         to the color pickers, based on hands-on feedback.
       Still to watch: dynamic-content rescans under heavier real-world use,
       and whether the reading-level estimate feels right on more pages.
8. [ ] Tune the CEFR band thresholds/percentile once it's been checked against
       a few real pages of known difficulty — the fixed values in
       `annotator.js` are a first guess, not calibrated against anything.
9. [ ] Consider expanding `data/cognates.json` past its ~360 hand-picked
       high-confidence entries if coverage feels thin in practice.

## Later phases (defer until Phase 2 is done)

See `README.md` for full roadmap. Summary:
- Phase 3: Leitner SRS, sentence mining, opt-in gamification
- Phase 4: PDF.js viewer with same features
