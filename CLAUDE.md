# CLAUDE.md

Chrome MV3 extension for learning French while browsing. Vanilla JS, no build step, load unpacked.

Full feature list and roadmap: see `README.md`. Current phase and next tasks: see `TODO.md`.

## Conventions

- **Service worker owns state and all external calls.** Content script and side panel are UI only — never fetch APIs or hold canonical state. The one exception: `background/offscreen.js` runs the actual `Translator.*` calls, because that API requires a window context the service worker can't provide (see MV3 constraints below) — the service worker still owns the message contract and orchestrates it.
- **Bubble CSS is namespaced `.fla-*`** to avoid collisions with host pages.
- **Every saved item stores context.** Never save a bare word — always with `contextSentence`, `sourceLang`, `url`, `savedAt`.
- **Vocab is keyed by URL**, not a flat array: `vocab[url] = [entries]`. Aggregate views are computed on demand.
- **Additive message contract** — add fields, don't rename or remove.

## Message contract

Request → response:
- `TRANSLATE` `{ text, contextSentence? }` → `{ source, translation, sourceLang, targetLang }`
- `SAVE_WORD` `{ entry }` → `{ ok, count }`
- `SAVE_VERB` `{ table }` → `{ ok }`
- `CONJUGATE` `{ verb }` → `{ ok, table } | { error }`
- `OPEN_SIDEPANEL` `{ view, verb? }` → `{ ok }`
- `SET_HOVER_MODE` / `SET_CURSOR_MODE` `{ enabled }` → `{ ok }`
- `READ_SELECTION` `{ lang }` → `{ ok }`
- `GET_DUE_REVIEWS` `{}` → `{ items }`
- `RECORD_REVIEW` `{ id, correct }` → `{ ok, nextDue }`

## Storage schema

```js
{
  vocab: { [url]: [{
    id, source, translation, sourceLang, targetLang,
    contextSentence, pos, gender, plural, savedAt, url,
    box, dueAt, lastReviewedAt, correctStreak, totalReviews  // Leitner SRS
  }] },
  verbs: [{ infinitive, tenses, savedAt, id, contextUrl }],
  config: {
    targetLang, defaultSourceLang, slowSpeech,
    cursorFollowMode, hoverModeEnabled,
    colorCoding: { enabled, masculine, feminine, plural, neutral },
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

- `verbs/<letter>.json` + `lemmas/<letter>.json` — ~7000 French verb conjugations, sharded by normalized first letter so a lookup only loads ~1/26th of the data. Generated from Verbiste XML.
- `lexicon.json` — Lexique.org derived; top 30k words with `{ lemma, pos, gender, number, freqRank }` (Phase 2)
- `cognates.json` — English-French cognate set (Phase 2)

Generation scripts live in `scripts/`.
