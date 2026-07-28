# TODO

Current phase: **Phase 1 — MVP**

## Weekend 1 tasks (in order)

1. [x] Generate real `data/verbiste.json` from Verbiste XML (~7000 verbs) via `scripts/build-verbiste.js`
2. [x] Add lemmatization to `background/conjugation.js` (selecting "mangeons" resolves to "manger")
3. [x] Add `getContextSentence(range)` in `content-script.js`; wire into `SAVE_WORD` flow
4. [x] Refactor `vocab` storage to per-URL keying; write one-time migration in `onInstalled`
5. [x] Add cursor-follow mode (click-to-translate default; hover-with-delay as reveal option)
6. [x] Add `background/cache.js` (7d TTL, 5000 entry cap); route `TRANSLATE` through it
7. [x] Add three placeholder icon PNGs at `icons/icon-{16,48,128}.png` (via `scripts/generate-icons.js`)

## Design-review follow-ups (2026-07-27) — do these before Phase 2

Ordered by impact. Phase 1 code is written but has never been run in a browser.

1. [ ] `git init` — the project has a `.gitignore` but no repo
2. [ ] Load unpacked in Chrome and read a real French article for 30 min.
       Everything below is unvalidated until this happens.
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
6. [ ] Redesign vocab/SRS schema **before** Phase 3 writes data into it.
       Leitner fields live per-URL, so the same word saved from two pages
       becomes two independent cards, and every due-query scans all buckets.
       Key SRS on the lemma with occurrences beneath it.
7. [ ] Manifest/doc hygiene:
   - [ ] Drop unused permissions: `contextMenus`, `scripting` (`alarms` is now
         used by the cache eviction sweep — no longer unused), and the
         `en.wiktionary.org` host permission
   - [x] Remove the `web_accessible_resources` block — done as part of the
         verbiste sharding work above (verified via Chrome's own docs that the
         service worker never needed it: "only pages or scripts loaded from an
         extension's origin can access that extension's resources," and the
         service worker already runs in that origin)
   - [ ] Reconcile CLAUDE.md with reality: `SAVE_VERB`, `GET_DUE_REVIEWS`,
         `RECORD_REVIEW` are documented but unimplemented; `hoverModeEnabled`
         and `cursorFollowMode` are documented inside `config` but stored as
         top-level keys; the side panel writes storage directly, violating
         "service worker owns state"
   - [x] Move the Google API key out of the URL query string — moot: Google/
         DeepL are gone entirely (see #4), no API key exists anymore

## Later phases (defer until Phase 1 is done)

See `README.md` for full roadmap. Summary:
- Phase 2: gender/plural color coding, frequency dimming, cognates, CEFR level
- Phase 3: Leitner SRS, sentence mining, opt-in gamification
- Phase 4: PDF.js viewer with same features
