# TODO

Current phase: **Phase 4 — PDF support** (Phase 3, Leitner SRS, deliberately
deferred — the user prioritized PDF support instead at this stage)
## Defects (2026-09-02)

**Unvalidated in a real browser** — same caveat every previous batch had before
its own hands-on pass.

1. [x] Tutorial - steps 4-6 the step info message is appearing below the pop up, so the point to the button is hidden
       — a z-index collision, not a placement bug. `content/popup.css` gives
       `.fla-bubble` the maximum z-index (2147483647) so it beats whatever a
       host page stacks; `lib/tour.css` puts the tour overlay at 9999. The
       welcome page is the one document where both exist, so the bubble painted
       over the callout for the Conjugate/Workbook/Save steps, arrow and all.
       `welcome/welcome.css` drops the bubble to 9998 for that page only —
       nothing there competes for the stack — so the callout is legible and the
       scrim now correctly dims the rest of the bubble around the spotlit button.
2. [x] Tutorial - steps 4-6 when it opens the workbook and you click got it on the pop up there it should move you to the next step.
       — the cross-document relay gained a return leg. `sidepanel.js` writes
       `tourSpotlightDone: { at }` when its relayed spotlight is dismissed
       (however it was dismissed — Got it, Skip, Esc, click-away), and
       `welcome.js` advances its tour when that `at` matches the spotlight it
       is waiting on. Matching on `at` rather than "something was dismissed" is
       what stops a stale acknowledgement advancing the tour twice.
3. [x] Tutorial - lets swap the order of steps 4 and 5? — Workbook now comes
       before Conjugate, and it reads better than the swap alone suggests: the
       workbook is where both of the other two buttons put their results, so
       meeting it first means the conjugation table and the saved word land
       somewhere already introduced.
4. [x] Tutorial - the "That's the page half..." message is now a callout over
       the button it's about. New `showHint()` in `lib/tour.js`: the same
       component a step uses, minus the scrim, blocker and footer, anchored to
       `#workbookTour`, self-dismissing after 9s. Deliberately NOT routed
       through `runTour()` — a hint must never become the `active` tour, or
       `isTourActive()` would report a tour running and the demo bubble would
       stop dismissing itself on click. `<p id="afterTourPrompt">` and its CSS
       are gone.
5. [x] Tutorial - "Select a whole passage" now lets the user do it. The welcome
       page reproduces the selection path as well as the click path
       (`demoSelection()`, `showSelectionBubble()`, `renderDeferredBubble()`,
       `segmentCount()` mirrored from `content/content-script.js`). The chapter
       is two steps: drag it yourself (interactive, `hideNext`, advances on a
       real selection), then the whole paragraph selected for you so the real
       deferred 🌐 Translate button is on screen to press. The demo paragraph
       gained two short sentences to reach four — `DEFER_TRANSLATE_SEGMENTS` is
       4, so without them the step couldn't demonstrate what it's about.
       Two traps found building it: (a) a bare `mouseup` listener re-reads
       whatever is still selected, so pressing the bubble's own 🌐 button
       rebuilt the bubble out from under the click and the button looked dead —
       fixed by only acting on a drag that *started* in the paragraph; (b) that
       step targets `.fla-bubble`, not `.fla-bubble .fla-translate`, because
       pressing 🌐 swaps the bubble's contents and a cutout aimed at the button
       would be measuring a detached element. `lib/tour.js` now also observes
       the target with its `ResizeObserver`, so the cutout follows the bubble
       as it grows.
6. [x] In the conjugation pop ups, the verb count / "no network" claim now
       appears exactly once, in the sidepanel spotlight the Conjugate button
       relays (`welcome.js#requestConjugation`). Dropped from the core tour's
       Conjugate step, the conjugation chapter, and the panel tour's
       Conjugation tab step.
7. [x] Reading a PDF step cut from three paragraphs of centred prose to two
       lines anchored on the drawn toolbar icon: where to click, and that
       everything works the same inside.
8. [x] Ignore only numbers selected — done. `getSelectionText()` (both
       copies) rejects a selection with no letter in it (`/\p{L}/u`): "2026",
       "12,5 %" and "(3)" are numbers, prices and footnote markers, never
       words, and translating one just echoed the digits back. Clicking a
       number was always inert — `getWordAtPoint()`'s word class is letters
       only — so this is the selection path catching up.
       **"Disable on pages with absolutely no French" — asked and declined,
       deliberately not built.** Four shapes were weighed (auto-dormant below a
       French-ness ratio with a per-site override; a manual per-site toggle
       only; auto-dormant with no escape hatch; nothing) and the call was that
       the numbers fix already removes the actual annoyance — clicking a word
       on an English page is at least a deliberate act, whereas a number
       echoing itself back was not.
       Worth recording for whoever revisits it: the detector would be nearly
       free. `content/annotator.js` already looks every scanned word up in the
       bundled lexicon, so the share that hits it is a usable French-ness
       ratio — an English page hits only coincidences (a, on, main, note, son,
       sur). The hard part was never the signal; it was that a page whose text
       arrives late, or a mostly-English page with a French quote, would go
       quiet with no obvious way to say otherwise. Any revival should carry a
       manual override, not just a threshold.
9. [x] Reworked the Practice tab's process and flow. Scoped via a `/grill-me`
       session first (interview log kept in the session, not duplicated here)
       — the load-bearing calls made there:
       - **No mic button.** The turn loop is fully automatic: a user turn
         shows a 2.5s countdown on its own line (left-border wipe + pulsing
         mic icon, one CSS transition, no JS ticking), then the mic opens on
         its own. `listenOnce()` already ended a turn on trailing silence, not
         a button press, so this was a matter of triggering it on a timer.
       - **Ready-screen editing.** Click a line's text to edit before Begin
         Practice; `×` deletes (floor of two lines); `+ line` appends a blank
         one. A commit re-translates just that line and re-derives mode/roles.
       - **Controls cut to Skip / Pause / Stop**, all live from any running
         state. The wall of instructional text on the ready screen and the
         per-turn "Your turn — say the highlighted line…" prompt are gone,
         replaced by a few words on the line itself ("Say this in French" /
         "Read this aloud") and a new ⓘ info modal for anyone who wants detail.
       - **Scores held back except on an outright miss.** A first attempt
         under 20% (`ADVANCE_GATE` — flat across modes, replacing the old
         per-mode pass bar as the thing that gates advancing) reveals the
         line's French and offers one more try — silence gets one retry, a
         wrong-but-spoken answer gets two. Budget spent marks the line
         **struggled**, kept distinct from **skipped** and **cleared**; all
         three show as the same neutral grey tick mid-session, splitting back
         apart in the summary. The reported score is always the **first**
         attempt (before any reveal) — a later attempt read off the reveal
         measures reading, not recall.
       - **Two consecutive fully-silent lines auto-pauses the session**
         instead of marching through the rest of the dialogue at zero; any
         hard recognition error pauses immediately too, for the same reason.
       - **Summary rewritten**: one row per user line — source text, the
         French reference (▶ to hear it), what was said, the coloured
         word-diff, and the score. Skipped-before-any-attempt rows show just
         source + reference, no diff.
       - **Paragraphs with no dialogue markers are a `solo` flag, not a new
         mode** — re-derived on every edit, since adding an English line to a
         French passage can turn it non-solo without any line gaining a
         marker. A solo French passage reads start to finish (no alternation);
         a solo English one was already identical to the existing all-English
         drill mode.
       Recognition's silence window went 1.8s → 2.5s (no ✓ Done button left to
       end a turn on purpose, so trailing silence needs more room for a
       mid-sentence pause) and the no-speech timeout 9s → 6s (the on-screen
       countdown already tells the user exactly when to start).
       **Unvalidated in a real browser** — same caveat every previous phase
       had before its own hands-on pass; the countdown timing, the 2.5s
       silence window and the repeat-budget sizes are reasoned guesses, most
       likely to need adjusting after one real session.
10. [x] Tech debt: tutorial-related punch list. Scoped via a `/grill-me`
        session first (interview log kept in the session, not duplicated
        here) — the seven items and what each turned into:
        - **Quotes on "traverse".** Every tour mention (steps 3, 5, and the
          conjugation chapter) now reads `"traverse"`, not *traverse* —
          quotes alone say "this exact word"; stacking italics on top read as
          over-marked for one word repeated six times.
        - **Steps 4–6 lead with what pressing the button does.** Workbook and
          Save already opened that way; Conjugate didn't ("When the word is a
          verb, this looks up its full conjugation…") and now does ("Opens
          your workbook's Conjugation tab, with "traverse" already looked
          up.").
        - **"Workbook pop ups to the bottom" turned out to mean something
          bigger once discussed**: not a placement bug (panel callouts
          already render below their targets) but that the workbook tour
          itself goes unnoticed as a separate, optional thing. See the merge
          below — this item and "emphasize the workbook tour more" resolved
          together.
        - **The post-core-tour nudge is louder, without the scrim that was
          asked for.** A scrim was ruled out deliberately (it would make
          `isTourActive()` true and stop the demo bubble dismissing on
          click — see `CLAUDE.md`), so instead: the hint's `showHint()`
          callout gained an accent border and heavier shadow, its on-screen
          duration went 9s → 14s, and a pulsing ring now draws the eye to the
          `#workbookTour` button itself. This is now the decline-only path —
          see the merge below for what happens on accept.
        - **The core and workbook tours are now one flow behind a consent
          gate**, not two tutorials you had to notice separately. The core
          tour's 6th step is followed by a 7th: a centred "One half done"
          step with two real buttons — **"Show me the workbook"** (accepts,
          hands off to the panel's own tour) and **"Not now"** (declines,
          same as any Skip). Accepting doesn't close anything; declining
          triggers the louder hint above. The existing standalone entry
          points ("Tour the workbook" on the welcome page, the panel's own
          first-open tour) are untouched — only added to, not replaced.
          `lib/tour.js` gained two small additive step options for this
          (`showSkip`, `skipLabel`) so a step can keep Skip visible even as
          the last one, with its own label.
        - **The traverse context-sentence bug — confirmed and fixed.**
          `CONTEXT_SENTENCE` was a single hardcoded constant (the demo
          paragraph's first sentence) fed to every clicked word regardless of
          which sentence it was actually in — harmless for a first-sentence
          word, silently wrong for "traverse" (second sentence), so saving it
          saved the wrong context. Replaced with `contextSentenceFor(range)`,
          the same probe-then-sentence-split principle `CLAUDE.md` already
          documents for the real content script, sized to the demo's flat,
          known DOM.
        - **Two new steps in the workbook tour**: a "Settings" step
          spotlighting the ⚙ tab (right after Practice, which already
          half-promised it: "the gear beside it holds every setting" was
          removed from Practice's own copy since this step now does that
          job), and a "Find a word" step spotlighting the search bar, before
          "Take it with you" (whose own copy dropped its now-duplicate
          mention of search).
        **Unvalidated in a real browser** — same caveat every previous phase
        had before its own hands-on pass. The seam between the two tours (the
        gate's accept path, `panelTourRequest`'s freshness window against
        `chrome.sidePanel.open()`'s user-activation requirement) is the part
        most worth a real hands-on check first.


## Defects (2026-09-11) — hands-on tutorial pass

Found by running the tutorial in a real browser. All four fixed; still
unvalidated in a browser themselves.

1. [x] **Centred tour steps rendered darker than anchored ones** — reported
       more than once before this and missed each time, because it looked
       like a theme/token problem and wasn't. `.fla-tour__callout` is
       `position: fixed` with `z-index: 1`, so it forms a stacking context,
       and a `z-index: -1` child of a stacking context does **not** paint
       behind its parent's background — the parent's background paints first
       and the negative child lands on top of it. The centred scrim was that
       child (`.fla-tour--centred .fla-tour__callout::before`), so 62% of the
       scrim colour was being painted over the callout's own `--fla-overlay`
       background. Every centred step (the new gate, the reading-aids
       sign-off, the practice and shortcuts chapters) was affected; anchored
       steps never were, since the pseudo-element only exists for centred
       ones — which is exactly why it read as "these two pop-ups have
       different colours". Now `.fla-tour--centred::before`, a sibling behind
       the callout rather than a child of it.
2. [x] **The demo bubble didn't move when the side panel opened.** Opening
       the workbook narrows the tab's viewport and reflows the paragraph, but
       the bubble had been positioned in page coordinates against the old,
       wider one — so it sat half under the panel's edge with its 📖 Workbook
       button sliced off, and the tour spotlit a button that was no longer
       fully on screen. The tour's own callout already re-placed itself on
       resize; the bubble now does too. `placeBubble()` stores its anchor on
       the element and a debounced `resize` listener re-runs it. The anchor is
       deliberately the live Element or Range, never a snapshot `DOMRect` —
       only the first two can be re-measured after a reflow, so the selection
       path now threads `sel.range` where it used to pass `sel.rect`.
3. [x] **The conjugation spotlight scrolled the panel into the middle of the
       tenses.** `scrollIntoViewIfNeeded()` centres its target, and
       `#conjugationTable` is taller than the panel viewport — centring
       something that can't fit guarantees its top scrolls off, taking the
       verb input and the tab bar with it. Now: a target at least as tall as
       the viewport whose top is already on screen isn't scrolled at all, and
       one whose top is above it gets `block: "start"` rather than `"center"`.
       Short targets are unaffected, so the other panel steps behave as before.
4. [x] **The workbook tour no longer dies on a stray click.** New
       `runTour({ dismissOnClickAway: false })` — the blocker still swallows
       clicks on the dimmed area but stops ending the tour. Used by both of
       the side panel's tours (the first-open walkthrough and the relayed
       spotlight), since the panel is a surface the user is being walked
       *through* and clicking a workbook row shouldn't quietly cancel the
       tutorial. The welcome page keeps the default: a popover on a page
       you're reading should close when you click away.
       **Esc and Skip deliberately still exit**, in both cases — the
       click-away default exists so a tour can't become a trap, and removing
       every exit would recreate exactly that. Say so if you want Esc gone
       too.

## Defects (2026-09-11, second pass)

1. [x] **The dark centred pop-up — actually fixed this time, and the earlier
       diagnosis was wrong.** It was never a theme or token problem, which is
       why several passes looking at colours found nothing. Two mechanisms,
       the first load-bearing: `.fla-tour--centred .fla-tour__callout` has
       `transform: translate(-50%, -50%)`, and **a transformed element becomes
       the containing block for its `position: fixed` descendants** — so the
       scrim's `inset: 0` resolved against the callout's own box, not the
       viewport. It never dimmed the page at all; it painted
       `rgba(4,22,39,0.62)` over the callout itself, turning a light `#eef2fa`
       panel into dark slate. (Separately: the callout is `position: fixed`
       with `z-index: 1`, so it forms a stacking context, and a `z-index: -1`
       child of one paints *above* its parent's background, not behind it.)
       Moving the scrim to the untransformed root fixes both the tint and the
       fact that centred steps never dimmed the page.
2. [x] **The tutorial now ends in one place and closes the workbook.**
       `finishTutorial()` shuts the panel, reveals the chapters and points at
       them with the same hint-plus-pulse treatment the workbook tour used to
       get. Declining the gate calls it directly; accepting it can't, because
       the workbook tour runs in the other document — so `sidepanel.js` writes
       `panelTourDone` when its tour ends (however it ended) and the welcome
       page finishes off that, guarded by an `awaitingPanelTour` flag so a
       tour the user starts themselves later can't re-trigger the ending.
       The old "take the workbook tour next" hint is gone: the gate already
       asks that question, so re-nagging about it after a decline was
       redundant — the chapters are the right next thing either way.
3. [x] **The passages chapter is four steps, not two** — the drag, the
       deferred preview, 🌐 Translate, 🎙 Practice, one idea each. The last
       three are deliberately non-interactive: pressing 🌐 swaps the bubble's
       contents out from under the cutout (a detached target measures all
       zeros and the spotlight jumps to the corner), and 🎙 would navigate to
       the side panel mid-chapter. `ensureDeferredBubble()` rebuilds the
       deferred state only when it isn't already up, so the three steps don't
       tear the bubble down and recreate it underneath the spotlight that just
       measured it.
4. [x] **Chapter tours no longer dismiss on click-away** — same
       `dismissOnClickAway: false` the side panel's tours use. Needed by the
       above: those steps spotlight buttons the blocker won't let you press,
       and with the default, reaching for the highlighted button would have
       closed the chapter instead. Skip and Esc still exit.
5. [x] **A taken chapter is dimmed, not ticked.** A tick adds a mark to read;
       receding says the same thing with nothing to read, and leaves the
       unvisited tiles as the only bright things in the grid. Hover restores
       it fully, since a taken chapter is still replayable. The icon greys via
       `filter: grayscale(1)`, never `opacity` — opacity on a tinted surface
       is exactly what `check-contrast.js` exists to catch.
6. [x] **Speaking practice and Shortcuts anchor to their own card** rather
       than centring. Both describe something that lives elsewhere (the mic is
       in the side panel, the shortcuts are on the keyboard), which is why
       they had nothing to point at — but the card the user just clicked is
       where their eye already is.

**Unvalidated in a real browser.** The riskiest piece is #2's accept path: if
the panel tour never runs, `panelTourDone` never arrives and the workbook
isn't closed. The chapters are revealed before that point either way, so the
user is never stuck — but the panel would stay open.

## Techdebt

1. []  what happens if its masc/fem and pulral at the same time 
2. []  make add words more apparent

## Features (2026-09-02)

1. [x] Colophon — "Made by Valmik" plus FAQ, Privacy and repo links, at the
       foot of the welcome page and at the foot of Settings in both the popup
       and the side panel (shared markup, wired once in
       `lib/settings-panel.js#wireAboutLinks`). Real `<a href>`s for
       middle-click and screen readers, but the plain click is intercepted and
       opened in a tab: following one in place would navigate the side panel
       away from the workbook, or load a page into a popup that closes the
       moment focus moves.
2. [x] `pages/faq.html` + `pages/privacy.html` (with `pages.css`/`pages.js`) —
       ordinary extension pages, theme-aware via `lib/theme-mode.js`, FAQ built
       from `<details>` so the browser owns the open/closed state. The privacy
       page discloses the one thing that genuinely isn't on-device: Chrome's
       Web Speech API transcribes practice audio through a Google service.
       Every other claim was checked against the code — no
       `chrome.storage.sync`, and no `fetch` outside bundled resources and the
       user-initiated "reopen this PDF".

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
8. [x] Load-test in a real browser: open a real multi-page PDF via the file
       picker, confirm text renders and click/hover/selection-translate all
       work over PDF.js's text-layer spans, confirm Save/Highlight both land
       in the same `pdf:<hash>` bucket on reopening the same file, and try
       the "reopen this PDF" button against both a CORS-friendly and a
       CORS-blocked host to confirm the failure message is sane rather than
       a silent hang. **Unvalidated in a real browser yet** — same caveat
       every previous phase had before its own hands-on pass.
9. [x] PDF.js's text runs don't always align 1:1 with visual word boundaries
       (justified text, rotated text, multi-column layouts) — expect some
       hover-precision tuning once tested against a real complex-layout PDF.
10. [x] Revisit auto-interception (`declarativeNetRequest` + broad host
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
