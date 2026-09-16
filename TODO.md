# TODO

Open work only. Completed phases have been removed — the *reasoning* behind
anything already built lives in [`CLAUDE.md`](CLAUDE.md)'s Conventions section,
and the blow-by-blow is in the git history.

**Built and working:** translation (click / drag / hover), contextual
vocabulary with workbooks and collections, conjugation, the PDF viewer,
conversation practice, the guided tutorial, theming, CSV/Anki export.

---

## Validation debt

The single most useful thing anyone could do right now.

- [ ] **Hands-on browser pass over the tutorial and practice flows.** The last
      several rounds of tutorial and Practice-tab work were written and
      statically checked but never exercised in a real browser. There is no
      test suite; every bug in this project's history surfaced by using it.
      Highest-risk spots, in order:
  - [ ] The tutorial's hand-off from the welcome page to the side panel — it
        depends on `panelTourRequest` landing inside a 10s freshness window
        while `chrome.sidePanel.open()` still holds its user activation. If
        the panel tour never runs, `panelTourDone` never arrives and the
        workbook is never closed.
  - [ ] Practice timings. `PRE_ROLL_MS` (2.5s), the 2.5s end-of-turn silence
        window, `FIRST_SPEECH_MS` (6s) and the repeat budgets are reasoned
        guesses, not calibrated against anyone actually speaking.
  - [ ] Practice's two-consecutive-silent-lines auto-pause, and recovery from
        a mid-session mic revoke.

## Phase 3 — spaced repetition

The last major unbuilt feature. Deferred once already, in favour of PDF
support.

- [ ] Review UI in the side panel.
- [ ] Handlers for `GET_DUE_REVIEWS` and `RECORD_REVIEW` — both are specified
      in `CLAUDE.md`'s message contract and neither has an implementation.
- [ ] Promote/demote logic. `background/srs.js` currently holds only the
      box→interval table (1d, 3d, 1w, 2w, 1m).
- [ ] Sentence mining — one action saves a whole sentence plus every unknown
      word in it.
- [ ] Opt-in gamification (streak, words reviewed today). `gameState` exists in
      the storage schema and is never read or written.

Groundwork is already in place: `cards` carries `box`, `dueAt`,
`lastReviewedAt`, `correctStreak` and `totalReviews`, keyed by lemma so the
same word saved from two pages is one card.

## Calibration

- [ ] **CEFR band thresholds.** The values in `content/annotator.js` are a
      first guess, never checked against pages of known difficulty. It bands on
      word-frequency rank alone and deliberately ignores the user's own
      `cards` history.

## Small fixes

- [ ] A noun that is masculine/feminine *and* plural gets only one colour —
      decide the precedence rule and make it deliberate rather than incidental.
- [ ] "Add a word" in the side panel is too easy to miss.

## Deferred, with reasons

Not scheduled. Recorded so the reasoning isn't re-derived from scratch.

- **Practice v1.1**: per-line language override on the ready screen (needs an
  additive forced-`sourceLang` field on `TRANSLATE`); semantic or
  multi-reference scoring for translate turns, so a correct-but-differently-
  phrased answer isn't graded against one machine rendering; persisting
  practice stats, which wants Phase 3's review data to exist first.

- **Auto-intercepting PDF navigation.** Would need `declarativeNetRequest` plus
  broad host permissions — a real permissions and Web-Store-review tradeoff.
  Manual open (file picker, or "reopen this PDF") stays the default until
  that friction proves too high in practice.

- **Disabling the extension on pages with no French.** Weighed and declined.
  The detector would be nearly free — `content/annotator.js` already looks
  every scanned word up in the bundled lexicon, so the share that hits it is a
  usable French-ness ratio. The hard part was never the signal: a page whose
  text arrives late, or a mostly-English page with a French quotation, would go
  quiet with no obvious way to say otherwise. Any revival needs a manual
  override, not just a threshold.

- **Conjugating the user's own sentence**, rather than showing a bare table.
  Blocked on a data gap as much as a design one: verb entries carry only
  `template` and `tenses`, with **no auxiliary field**, so passé composé can't
  be built (avoir vs être unknown), let alone agreed (`elle est allée`). Any
  first version is limited to présent / imparfait / futur / conditionnel until
  `scripts/build-verbiste.js` is extended to emit the auxiliary. The safe
  design is substitution offered *only* where the shape is provable —
  recognised subject pronoun immediately before the verb, simple tense, not
  reflexive — showing the plain table otherwise. Never display wrong French.
  Also needs an additive `contextSentence` field on the `OPEN_SIDEPANEL`
  intent.

- **Expanding `data/cognates.json`** past its ~360 hand-picked entries. Moot
  unless cognate highlighting is revived — the feature is retired, though the
  data still ships and `LOOKUP_WORDS` still returns it, so reviving it would be
  a UI change rather than a data one.

- **Frequency dimming and cognate highlighting.** Retired, not deleted. The
  toggles, CSS classes and config keys are gone; the data and the message
  fields stay. Don't "tidy" them away.

## Ideas, unexamined

- YouTube subtitle overlay with clickable words.
- Wiktionary definitions in the save flow.
- Notion sync.

---

## Housekeeping

- [ ] **Confirm Lexique's redistribution terms.** `data/Lexique4/Lexique4.tsv`
      (32MB) is committed so `npm run build:lexicon` works from a clone, but
      its licence hasn't been verified against a primary source — the site is
      HTTP-only. If redistribution isn't permitted, untrack it; `.gitignore`
      has the rule ready, commented out, and the extension is unaffected
      either way since it loads the generated `data/lexicon/` shards. See
      [`NOTICE.md`](NOTICE.md).
- [ ] **Decide whether to publish to the Chrome Web Store.** Store review will
      want a privacy justification for each permission; `pages/privacy.html`
      already covers the substance.
