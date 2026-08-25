# TODO

Current phase: **Phase 4 — PDF support** (Phase 3, Leitner SRS, deliberately
deferred — the user prioritized PDF support instead at this stage)

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

## Phase 4 tasks (PDF support — Phase 3 deferred, see note at top)

Manual-open only, by explicit choice: the alternative (auto-intercepting
every PDF navigation site-wide) needs `declarativeNetRequest` + broad host
permissions — a real permission-prompt/Web-Store-review decision, deliberately
deferred rather than added silently. See CLAUDE.md's Conventions section for
the full rationale.

1. [x] Vendored PDF.js v6.1.200 into `pdf-viewer/vendor/` (display API only —
       `pdf.mjs`, `pdf.worker.mjs`, `pdf_viewer.css`, `cmaps/` — not Mozilla's
       own prebuilt viewer UI). See `vendor/README.txt` for exact provenance
       and upgrade steps.
2. [x] `lib/pdf-handoff.js` — IndexedDB-backed handoff of picked/fetched PDF
       bytes to the viewer tab (not `chrome.storage.session`: no confirmed
       binary/ArrayBuffer support there, and a 10MB quota that base64 would
       shrink to ~7.5MB of real PDF — too small for scanned documents).
       Records aren't deleted on read, only swept periodically (new
       `chrome.alarms` alarm in `service-worker.js`, mirroring `cache.js`'s
       eviction pattern) so an accidental viewer-tab reload doesn't strand
       the user.
3. [x] Required one-line fix in `service-worker.js`'s `SAVE_WORD` handler —
       it used to unconditionally overwrite `entry.url` with `sender.tab.url`,
       which would have corrupted `pdf-viewer/viewer.js`'s `pdf:<hash>` key
       with the viewer's own `chrome-extension://.../viewer.html?...` address.
4. [x] `pdf-viewer/viewer.html`/`viewer.js` — continuous-scroll render
       pipeline (every page gets a correctly-sized placeholder up front;
       canvas + PDF.js text-layer are only actually rendered once a page
       scrolls near the viewport, via `IntersectionObserver` — rendering a
       long PDF's pages all eagerly would be slow/memory-heavy). Content-hash
       computed via `crypto.subtle.digest`, click/hover/selection-translate logic **ported**
       from `content/content-script.js` (not shared/injected — content
       scripts don't run on the extension's own pages; see CLAUDE.md). Same
       interaction model as web pages: click always translates, hover-dwell
       is optional/additive, selection always translates the whole selection.
5. [x] Overlay highlight annotations — `pdfAnnotations` storage keyed by
       content hash (see CLAUDE.md schema), rects stored in PDF user-space
       points via PDF.js's `PageViewport#convertToPdfPoint`/
       `convertToViewportPoint` so they survive zoom/resize. A "🖍 Highlight"
       button on the translation bubble, alongside Save/Conjugate/Workbook.
6. [x] Popup entry points: a file picker (`<input type=file>`, always works,
       any PDF) and a "reopen this PDF" button shown when the active tab's
       URL already ends in `.pdf` (fetches the tab's URL directly — **known,
       sizable limitation**: this fetch runs from the popup's
       `chrome-extension://` origin, so it only succeeds against
       CORS-permissive hosts; most publisher/enterprise/Drive-hosted PDFs
       will fail it and show an error pointing at the file picker instead —
       accepted cost of not requesting new host permissions).
7. [x] Sidepanel: PDF entries show `entry.pdfTitle || "PDF document"` instead
       of the raw content hash.
8. [ ] Load-test in a real browser: open a real multi-page PDF via the file
       picker, confirm text renders and click/hover/selection-translate all
       work over PDF.js's text-layer spans, confirm Save/Highlight both land
       in the same `pdf:<hash>` bucket on reopening the same file, and try
       the "reopen this PDF" button against both a CORS-friendly and a
       CORS-blocked host to confirm the failure message is sane rather than
       a silent hang. **Unvalidated in a real browser yet** — same caveat
       every previous phase had before its own hands-on pass.
9. [ ] PDF.js's text runs don't always align 1:1 with visual word boundaries
       (justified text, rotated text, multi-column layouts) — expect some
       hover-precision tuning once tested against a real complex-layout PDF.
10. [ ] Revisit auto-interception (`declarativeNetRequest` + broad host
        permissions) later if manual-open proves too much friction in
        practice — deliberately deferred, not ruled out.
11. [x] Hands-on feedback round after the first real-browser test — three
        fixes:
        - Highlight rects merged per visual line before storing/drawing
          (`mergeLineRects()`) — superseded shortly after by item 13 below
          (switched to PDF.js's own native highlighter entirely, dropping
          this custom code); kept in this log as a record of what was tried.
        - Side panel's Vocab tab now has a workbook sidebar (one workbook per
          saved page/PDF, plus "All workbooks"), with rename and
          delete-entire-workbook actions. `deleteWorkbook()` also cleans up
          `cards`/`workbookNames` for that workbook, not just `vocab`.
          Regular web-page saves now capture `pageTitle`
          (`document.title`) the same way PDF saves capture `pdfTitle`, so
          workbook labels are readable instead of raw URLs.
        - Conjugation tab's "＋ Save to workbook" button was actually working
          but gave zero feedback, so a successful save looked identical to a
          silently broken one — now shows "Saved ✓" / a failure message.
12. [x] Switched `pdf-viewer/viewer.js` from single-page-at-a-time to
        continuous scroll, per direct request — this was the biggest UX gap
        once someone actually tried reading a multi-page PDF with it.
        **Superseded by item 13 below** — this hand-rolled continuous-scroll
        rewrite turned out to have a real layout bug (pages rendered on top
        of each other instead of stacking), so the whole custom render
        pipeline was replaced rather than debugged further. Kept in this log
        as a record of what was tried.
13. [x] Replaced the hand-built PDF viewer entirely with Mozilla's own
        prebuilt PDF.js reference viewer (`pdf-viewer/vendor/web/viewer.mjs`,
        vendored whole — see `vendor/README.txt`), after the custom
        continuous-scroll layout broke and the custom highlight overlay
        stayed janky even after the line-merge fix. Both problems were
        re-implementations of things the stock viewer already does
        correctly — proper virtualized scroll/zoom, and a pixel-correct
        native highlight annotation tool. `pdf-viewer/bridge.js` replaces
        the old `pdf-viewer/viewer.js`: it only adds translate/save/
        conjugate/workbook features and handoff-loading on top (via
        `PDFViewerApplication`'s public API/event bus), touching nothing
        about rendering. The custom `pdfAnnotations` storage and highlight-
        overlay code (including the just-added `mergeLineRects()` fix) are
        gone — dropped, not just unused, since PDF.js's own highlighter
        replaces the feature outright. Trade-off accepted knowingly: the
        viewer now looks like Mozilla's own full toolbar UI (find bar,
        print, sidebar, etc.) instead of the slim custom one.
        Still unvalidated in a real browser — same caveat every previous
        PDF-viewer iteration had before its own hands-on pass.
14. [x] Vocab tab's "All workbooks" selection used to show a flat dump of
        every saved word across every workbook — same behavior as before
        workbooks existed at all, just not what "All workbooks" should mean
        once workbooks are a real concept. It now shows the list of
        workbooks themselves (clickable to drill in), matching the sidebar;
        typing a search still searches across every workbook's words, since
        that's still useful.
        **Reverted by item 15 below** — kept in this log as a record of what
        was tried.
15. [x] Reverted item 14: the workbook-overview screen (list of workbooks,
        clickable to drill in) is gone, and the sidebar's top entry is back
        to a flat dump of every saved word across every workbook, per direct
        request. Renamed that entry from "All workbooks" to "All Words" —
        individual per-page/PDF workbooks in the sidebar are unaffected.
16. [x] Two fixes: (1) `#workbookHeader`'s `hidden` attribute was losing to
        `.workbook-header { display: flex }` on specificity — same-specificity
        class rule beats the UA `[hidden]` rule when it comes later in the
        cascade — so the workbook name/rename/delete buttons stayed visible
        after switching to "All Words". Added an explicit
        `.workbook-header[hidden] { display: none }` override.
        (2) Added a Settings tab (⚙) to the side panel, showing the same
        toggles as the popup (hover mode, slow speech, color coding,
        frequency dimming, cognate highlighting, reading level). Extracted
        the shared logic into `lib/settings-panel.js` rather than duplicating
        it, since popup and side panel are both regular extension pages that
        can import a real module (see CLAUDE.md). PDF-open and "Open
        workbook" stayed popup-only — they're actions, not settings, and
        don't make sense from inside the panel they'd open.

## Phase 5 tasks (Conversation Practice — built ahead of the still-deferred Phase 3, per direct request)

Code is written but **nothing below has been validated in a real browser yet**
— same caveat every previous phase had before its own hands-on pass. The
whole feature gates on item 1 (the mic/recognition spike): nothing in this
repo had ever used `webkitSpeechRecognition` before, and Chrome extension
pages have a history of `not-allowed`/`network` errors with it.

1. [ ] **Spike / first hands-on check**: load unpacked → side panel → DevTools
       on the panel → run a throwaway snippet
       (`const r=new webkitSpeechRecognition(); r.lang="fr-FR"; r.onresult=e=>console.log(e.results); r.onerror=e=>console.log("ERR",e.error); r.start();`)
       — expect `not-allowed` before granting. Open
       `chrome-extension://<id>/permission/grant-mic.html`, grant, re-run the
       snippet, speak French, confirm a transcript arrives inside the panel.
       **Contingency if it still fails**: re-host the practice UI in a
       dedicated extension tab (`practice-panel.js` is a plain module wired to
       DOM ids, so relocation is re-hosting, not a rewrite).
2. [x] `lib/fuzzy-match.js`: added `alignWords()` (LCS alignment + backtrace)
       additively beside the old positional `wordDiff()` — one inserted/
       dropped word no longer desyncs every word after it.
3. [x] `lib/practice-panel.js` — full session state machine: line parsing
       (speaker-tag/dash stripping, sentence-split fallback), per-line
       classification via one `TRANSLATE` each (sourceLang → fr/en chip,
       translation → Mode B reference / display gloss), Mode A (all-French,
       alternating read-aloud turns, swap-roles toggle) vs Mode B (mixed,
       user translates English lines into spoken French), listen/retry/skip
       on failed turns, pause-on-tab-switch with resume, end-of-session
       summary (per-line best %, overall %, repeated mistakes at 2+ misses).
       Pass thresholds — A ≥ 0.75, B ≥ 0.55 (lenient because the machine
       translation is only one valid rendering; shown as "suggested
       translation") — are **first guesses, uncalibrated** until tested.
4. [x] `permission/grant-mic.html`/`.js` — one-time mic grant page (no
       manifest change; `audioCapture` is Chrome-Apps-only, deliberately not
       added).
5. [x] Side panel wiring: Practice tab UI replaces the stub; `sidepanelIntent`
       now also consumed via `chrome.storage.onChanged` (fixes the
       already-open-panel gap — previously a second OPEN_SIDEPANEL wrote an
       intent nothing ever read), deduped by intent `at`; `speak()` finally
       honors `config.slowSpeech` (pre-existing bug: the setting existed in
       schema + settings UI but every speak() hardcoded rate 0.9 —
       content-script.js/bridge.js copies still do, left for a later pass).
6. [x] 🎙 Practice button on the selection bubble in **both** copies
       (content-script.js + bridge.js), shown only for multi-line or
       multi-sentence selections; sends `OPEN_SIDEPANEL {view:"practice",
       text}` (additive `text` field on the existing intent).
7. [ ] Hands-on pass (after item 1 passes):
       - [ ] Paste path, Mode A: 6-line French dialogue → app reads line 1
             (slowSpeech respected when toggled), correct reading of line 2
             passes at ≥0.75; deliberately insert an extra word mid-sentence
             and confirm the diff does NOT redline everything after it.
       - [ ] Mode B: alternating fr/en → a differently-phrased-but-correct
             French answer still passes at 0.55.
       - [ ] Selection path with panel closed → opens on Practice with text;
             single-word bubbles show no 🎙 button.
       - [ ] Selection path with panel already open on Vocab → switches and
             loads (the onChanged fix).
       - [ ] Fail/retry/skip loop; miss the same word twice → it appears
             under repeated mistakes; overall % sane.
       - [ ] Stop mid-turn: TTS halts, recognition aborts, new session works.
       - [ ] Revoke mic in site settings mid-session → next turn surfaces the
             grant button rather than hanging.
       - [ ] Silent for ~12s on an armed mic → "didn't catch that" + retry,
             no hang.
       - [ ] PDF selection: 🎙 appears; note (don't fix) how the per-visual-
             line `\n`s split sentences; confirm the textarea path is a
             workable fallback.
8. [x] Tune the pass thresholds + French ASR tolerance once real attempts
       have been scored — done in the first feedback round (item 10 below);
       scoring moved off raw character-Levenshtein onto a phonetic scorer.
9. [ ] v1.1 candidates, deliberately deferred: per-line language override on
       the ready screen (needs an additive forced-`sourceLang` field on
       `TRANSLATE`), semantic/multi-reference scoring for Mode B, practice
       stats persistence (`practiceStats`) once Phase 3's review data lands.
10. [x] **First hands-on feedback round** (mic worked once the right input
        device was selected — item 1's spike effectively passed). Five fixes:
        - **Popup → practice with the page selection.** New `GET_SELECTION`
          message, answered by both `content/content-script.js` and
          `pdf-viewer/bridge.js`; a "🎙 Practice selected text" button in the
          popup writes `sidepanelIntent` and opens the panel itself (the
          existing `OPEN_SIDEPANEL` handler keys off `sender.tab`, which a
          popup doesn't have). Both listeners stay silent when they hold no
          selection, so an empty iframe / background PDF tab can't win the
          response race with "".
        - **Live mic level meter** (`#practiceWave`) while listening — a
          second, parallel `getUserMedia` stream feeding an AnalyserNode,
          purely so the user can see audio arriving. Recognition itself gives
          no signal until it has decoded words, which is exactly why a
          wrong input device was indistinguishable from silence. Also warns
          after 2.5s of no signal, naming the input device as the suspect.
        - **Recognition is now `continuous`.** It was ending at Chrome's
          first final result, i.e. scoring a whole line on its opening word.
          The turn now ends on 1.8s of silence, a ✓ Done button, or a 30s
          cap, and words light up as they're recognised (Mode A only —
          highlighting the reference on a Mode B translate-turn would hand
          the user the answer).
        - **Pronunciation-aware scoring** — feedback was far too harsh
          because character-Levenshtein punishes spellings French pronounces
          identically. `fuzzy-match.js` gained `phoneticKey()` (French
          grapheme→sound folding) and `pronunciationScore()` (word-level edit
          distance: cheap insertions, full-price deletions, partial credit
          only above a floor). "parler"/"parlé"/"parlez" now score 1.00
          where they scored 0.83; a genuinely wrong content word still fails.
          Thresholds rescaled with it: A 0.75 → 0.78, B unchanged at 0.55.
        - **Mic grant is a modal gate**, not a permanent button parked under
          the controls — shown on entering Practice without permission, and
          re-raised (overriding "Not now") on a real `not-allowed` error.
11. [x] **Second feedback round** — four fixes, one item deferred to discussion:
        - Hover dwell 400ms → 900ms. At 400 a cursor crossing a paragraph
          strobed a bubble over every word it passed.
        - Playback of the model French from the feedback: a 🐢 Slowly button
          (rate 0.5, slower than `config.slowSpeech`'s 0.7) beside the
          existing 🔊 Listen on a miss, a ▶ on every summary row, and a ▶ on
          the revealed answer of a resolved translate turn. `speakAsync()`
          took an optional `rate` override for this.
        - **Mode C** (all-English dialogue → user speaks every line in
          French). Falls out of Mode B's design almost entirely: with no
          French lines there are no app turns, so every line is a translate
          turn. Added `isTranslateTurn()` as the one place that asks "must
          the user produce French here", replacing the scattered
          `mode === "B" && lang === "en"` checks.
        - Bubble sizing/placement: `placeBubble()` re-measures after every
          content swap and moves the bubble beside a tall selection;
          `max-height: 60vh` + internal scroll caps it regardless. Passage
          selections (4+ segments) now defer translation behind a 🌐
          Translate button, so grabbing a long dialogue for Practice no
          longer buries the screen in translated text.

## Stretch goals (tabled — designed, not scheduled)

- **Conjugation in full sentences.** Show the user's context sentence
  re-conjugated for each person, not just the bare verb table. Discussed and
  deliberately tabled. Three options were weighed:
  1. *Pure substitution* — find the conjugated form in the sentence (we have
     every form already) and swap it plus the subject pronoun. Free, offline,
     instant; but wrong on elision (`je` → `j'`), reflexives (`je me lave` →
     `tu te laves`), possessives (`avec mes amis` → `tes amis`), and
     non-pronoun subjects (`Marie parle…` — nothing to swap).
  2. *Chrome's Prompt API* (`LanguageModel`) — one call per sentence, reusing
     the offscreen-document plumbing `Translator` already needs. Handles the
     hard cases; costs a flag/origin-trial-gated dependency, 1–3s latency, and
     it's generative, so it can quietly rewrite the input.
  3. *Hybrid, recommended* — do (1), but only offer the sentence view when the
     shape is provable: recognised subject pronoun immediately before the
     verb, simple tense, not reflexive. Otherwise show the bare table with no
     sentence toggle. Never displays wrong French; sometimes declines.
  **Hard data constraint**: verb entries carry only `template` and `tenses` —
  there is **no auxiliary field**, so passé composé can't be built (avoir vs
  être unknown) let alone agreed (`elle est allée`). Any v1 is limited to
  présent / imparfait / futur / conditionnel until `scripts/build-verbiste.js`
  is extended to emit the auxiliary.
  **Prerequisite**: the Conjugate button sends `OPEN_SIDEPANEL {view:
  "conjugation", verb}` with no sentence — needs an additive
  `contextSentence` field on that intent.

## Later phases (defer until Phase 4 is done)

See `README.md` for full roadmap. Summary:
- Phase 3: Leitner SRS, sentence mining, opt-in gamification (deferred ahead
  of Phase 4 at the user's request — see note at top of this file)
