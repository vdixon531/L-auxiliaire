# CLAUDE.md

Chrome MV3 extension for learning French while browsing. Vanilla JS, no build step, load unpacked.

Full feature list and roadmap: see `README.md`. Current phase and next tasks: see `TODO.md`.

## Conventions

- **Service worker owns state and all external calls.** Content script and side panel are UI only — never fetch APIs or hold canonical state. The one exception: `background/offscreen.js` runs the actual `Translator.*` calls, because that API requires a window context the service worker can't provide (see MV3 constraints below) — the service worker still owns the message contract and orchestrates it.
- **Bubble CSS is namespaced `.fla-*`** to avoid collisions with host pages.
- **Every saved item stores context.** Never save a bare word — always with `contextSentence`, `sourceLang`, `url`, `savedAt`.
- **Vocab is keyed by URL**, not a flat array: `vocab[url] = [entries]`. Aggregate views are computed on demand.
- **SRS state lives on `cards`, keyed by lemma — never on vocab occurrences.** The same word saved from two pages is one card, not two. Each occurrence points at its card via `cardId`; each card tracks its occurrences via `occurrenceIds`. A due-review query scans `cards` (one entry per distinct word), never every URL bucket. `background/conjugation.js`'s `resolveLemma()` collapses verb forms onto their infinitive; anything it doesn't recognize falls back to its own lowercased (accent-preserved) surface form.
- **Bundled-data lookups (conjugation, lexicon) are background-owned.** `background/lexicon.js` mirrors `conjugation.js`'s shard-cache pattern for `data/lexicon/<letter>.json` + `data/cognates.json`. `saveWord()` fills `pos`/`gender`/`plural` from a lexicon lookup when the caller didn't supply them. `content/annotator.js` batches its per-page word list into one `LOOKUP_WORDS` message per scan rather than looking up bundled data itself, keeping that precedent — even though content scripts technically can fetch bundled extension resources directly.
- **Reading-aid config (`colorCoding`/`frequencyDimming`/`cognateHighlighting`) is live across every open tab**, not just the active one — `content/annotator.js` reacts via `chrome.storage.onChanged` rather than the `SET_HOVER_MODE`-style "message the active tab" pattern used for interaction-mode toggles. Annotation always tags matched words with their computed classes at scan time; a class on `<html>` gates whether those styles actually render, so flipping a setting never requires re-walking the DOM.
- **Additive message contract** — add fields, don't rename or remove.

## Message contract

Request → response:
- `TRANSLATE` `{ text, contextSentence? }` → `{ source, translation, sourceLang, targetLang }`
- `SAVE_WORD` `{ entry }` → `{ ok, count }`
- `SAVE_VERB` `{ table }` → `{ ok }`
- `CONJUGATE` `{ verb }` → `{ ok, table } | { error }`
- `OPEN_SIDEPANEL` `{ view, verb? }` → `{ ok }`
- `SET_HOVER_MODE` `{ enabled }` → `{ ok }` — click-to-translate is always on (no toggle/message for it); hover-dwell is the only optional mode, additive on top of click
- `READ_SELECTION` `{ lang }` → `{ ok }`
- `GET_DUE_REVIEWS` `{}` → `{ items }` — **Phase 3, not yet wired** (no service-worker handler yet; `cards` now has the `dueAt` field this will scan)
- `RECORD_REVIEW` `{ id, correct }` → `{ ok, nextDue }` — **Phase 3, not yet wired** (`background/srs.js` currently only has the box→interval table; promote/demote-on-review logic still to come)
- `LOOKUP_WORDS` `{ words }` → `{ entries: {[word]: {lemma,pos,gender,number,freqRank}|null}, cognates: {[word]: string} }` — batched lexicon + cognate lookup, one call per `content/annotator.js` scan pass
- `GET_PAGE_LEVEL` `{}` → `{ level: "A1".."C2"|null, pending? }` — sent **popup → content script directly** (not background-routed; `annotator.js` already holds the per-page data from its own scans). Frequency-rank banding only — v1 deliberately does not factor in the user's known-vocabulary/`cards` data, to keep the metric simple and independent of review history

## Storage schema

```js
{
  vocab: { [url]: [{
    id, cardId, source, translation, sourceLang, targetLang,
    contextSentence, pos, gender, plural, savedAt, url
  }] },  // occurrences only — no SRS fields here, see `cards` below
  cards: { [lemma]: {
    lemma, sourceLang, targetLang, translation, pos, gender, plural,
    contextSentence,               // copied from the latest occurrence, for review display
    occurrenceIds: [{ url, id }],  // pointers back into vocab[url]
    box, dueAt, lastReviewedAt, correctStreak, totalReviews,  // Leitner SRS
    createdAt
  } },
  verbs: [{ infinitive, tenses, savedAt, id, contextUrl }],
  config: {
    targetLang, defaultSourceLang, slowSpeech,
    hoverModeEnabled,
    colorCoding: {
      enabled, masculine, feminine, plural, neutral,        // master switch + hex colors
      categoriesEnabled: { masculine, feminine, plural, neutral }  // per-category on/off, independent of color choice
    },
    frequencyDimming, cognateHighlighting, gamification,
    reviewsPerSession
  },
  gameState: { streak, lastActiveDate, wordsReviewedToday, totalWordsReviewed, totalWordsSaved },
  translationCache: { [hash]: { translation, sourceLang, targetLang, ts } }  // 7d TTL, capped
}
```

Leitner intervals: box 1→5 = 1d, 3d, 1w, 2w, 1m. Correct promotes, wrong drops to box 1.

## MV3 constraints (silent-bug traps)

- No inline `<script>` in HTML.
- Service worker can die between events — persist to `chrome.storage`, don't hold in-memory state.
- Content script runs on `<all_urls>` — be defensive, don't break host pages.
- `webkitSpeechRecognition` is Chrome-only (Firefox port would lose Practice tab).
- `Translator.*`/`LanguageDetector.*` don't work in Web Workers — a service worker is one, so it can't call them directly. That's why `background/offscreen.js` exists: it's spawned via `chrome.offscreen.createDocument` and relayed through, since offscreen documents have a real window context. Requires Chrome 138+.
- `chrome.runtime.sendMessage` fans out to every *other* extension context (the sender's own exact listener never receives its own broadcast) — with three contexts now sharing one bus (service worker, offscreen doc, content scripts), a message meant for one will still reach the others' listeners. Filter by `msg.type` before acting, and don't assume "my listener didn't fire" means "nothing else did either."

## Data bundles (in `data/`)

- `verbs/<letter>.json` + `lemmas/<letter>.json` — ~7000 French verb conjugations, sharded by normalized first letter so a lookup only loads ~1/26th of the data. Generated from Verbiste XML via `scripts/build-verbiste.js`.
- `lexicon/<letter>.json` — Lexique.org derived (source: `data/Lexique4/Lexique4.tsv`), top 30k surface forms with `{ lemma, pos, gender, number, freqRank }`, same first-letter sharding scheme. Generated via `scripts/build-lexicon.js`. `pos` is the raw Lexique `Cgram` code; homographs (same spelling, multiple grammatical readings — e.g. "ferme" as VER/ADV/ADJ/NOM) collapse to one entry keyed by the reading with the highest word-form frequency, but ranked by the spelling's aggregate frequency across all readings — see the script's header comment for the full rationale.
- `cognates.json` — hand-curated English-French cognate map (not scripted — there's no reliable way to derive true cognates vs. false friends from frequency/POS data alone), `{ frenchWord: englishCognate }`

`scripts/shard-writer.js` holds the shared `normalize()`/`shardKeyOf()`/`writeSharded()` build-time helpers (CommonJS, used by both build scripts). `background/conjugation.js` and `background/lexicon.js` each keep their own small runtime copy of `normalize`/`shardKeyOf` (different module system — ES modules in the service worker) — all copies must match exactly, or a word looks up a shard that was never built for it.
