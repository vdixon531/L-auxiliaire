# CLAUDE.md

Chrome MV3 extension for learning French while browsing. Vanilla JS, no build step, load unpacked.

Full feature list and roadmap: see `README.md`. Current phase and next tasks: see `TODO.md`.

## Conventions

- **Service worker owns state and all external calls.** Content script and side panel are UI only — never fetch APIs or hold canonical state. The one exception: `background/offscreen.js` runs the actual `Translator.*` calls, because that API requires a window context the service worker can't provide (see MV3 constraints below) — the service worker still owns the message contract and orchestrates it.
- **Bubble CSS is namespaced `.fla-*`** to avoid collisions with host pages.
- **The bubble is measured and re-placed after every content swap** (`placeBubble()`, duplicated in `content/content-script.js` and `pdf-viewer/bridge.js`) — "Translating…", a one-word gloss, and a paragraph's translation are wildly different sizes, so a position computed once at creation is wrong by the time there's content in it. It anchors below the selection by default, but moves *beside* it when the anchor is tall or the space below is thin, and clamps into the viewport as a last resort; `max-height: 60vh` + internal scroll in `content/popup.css` is what guarantees the action buttons stay on screen no matter how long the translation is.
- **Passage-length selections don't auto-translate.** At `DEFER_TRANSLATE_SEGMENTS` (4) lines-or-sentences the bubble renders a preview plus a 🌐 Translate button and waits — the common case for a long selection is wanting Practice, not a wall of translated text. The Translate button exists **only** in this deferred state; once translated the bubble is an ordinary one, and short selections never show it. Note the two copies of `segmentCount()` differ *deliberately*: a PDF text layer emits a `\n` per visual line, so `bridge.js` counts sentences where `content-script.js` counts lines first.
- **Reading-aid/toggle settings UI (`lib/settings-panel.js`) is a shared module between `popup.js` and `sidepanel.js`'s Settings tab** — both are regular extension pages (unlike content scripts, which can't import extension modules, hence `content/annotator.js` keeping its own `DEFAULT_COLORS`/`DEFAULT_CATEGORIES_ENABLED` copy), so this is a real shared module rather than a duplicated one. Both callers must provide the same element IDs in their HTML; `initSettingsPanel()` is idempotent (guards its own listener wiring) since the side panel's Settings tab can call it more than once per document lifetime, unlike the popup which is recreated fresh every open.
- **Every saved item stores context.** Never save a bare word — always with `contextSentence`, `sourceLang`, `url`, `savedAt`.
- **Vocab is keyed by URL**, not a flat array: `vocab[url] = [entries]`. Aggregate views are computed on demand.
- **SRS state lives on `cards`, keyed by lemma — never on vocab occurrences.** The same word saved from two pages is one card, not two. Each occurrence points at its card via `cardId`; each card tracks its occurrences via `occurrenceIds`. A due-review query scans `cards` (one entry per distinct word), never every URL bucket. `background/conjugation.js`'s `resolveLemma()` collapses verb forms onto their infinitive; anything it doesn't recognize falls back to its own lowercased (accent-preserved) surface form.
- **Bundled-data lookups (conjugation, lexicon) are background-owned.** `background/lexicon.js` mirrors `conjugation.js`'s shard-cache pattern for `data/lexicon/<letter>.json` + `data/cognates.json`. `saveWord()` fills `pos`/`gender`/`plural` from a lexicon lookup when the caller didn't supply them. `content/annotator.js` batches its per-page word list into one `LOOKUP_WORDS` message per scan rather than looking up bundled data itself, keeping that precedent — even though content scripts technically can fetch bundled extension resources directly.
- **Reading-aid config (`colorCoding`/`frequencyDimming`/`cognateHighlighting`) is live across every open tab**, not just the active one — `content/annotator.js` reacts via `chrome.storage.onChanged` rather than the `SET_HOVER_MODE`-style "message the active tab" pattern used for interaction-mode toggles. Annotation always tags matched words with their computed classes at scan time; a class on `<html>` gates whether those styles actually render, so flipping a setting never requires re-walking the DOM.
- **PDF support is manual-open only, by design.** MV3 extensions can't silently register as Chrome's default PDF handler the way the old `mimeHandlerPrivate` API allowed — the realistic options were auto-intercepting every PDF navigation (needs `declarativeNetRequest` + broad host permissions) or manual open (file picker / "reopen this PDF" button, no new permissions). This project chose manual-open; the viewer is reached only via `chrome.tabs.create` from `popup.js`, never via navigation interception.
- **The PDF viewer is Mozilla's own prebuilt PDF.js reference viewer** (`pdf-viewer/vendor/web/viewer.html` + `viewer.mjs`), not a hand-built one. A hand-rolled render pipeline was tried first (single-page, then continuous-scroll) and broke twice — both times because it was re-implementing things PDF.js's own viewer already does correctly (proper virtualized continuous scroll, zoom, and a pixel-correct native highlight annotation tool). Don't re-attempt a custom render pipeline; if the stock viewer is ever swapped for a newer PDF.js release, re-vendor `web/` + `build/` wholesale (see `vendor/README.txt`) rather than cherry-picking files — its internal `cMapUrl`/`standardFontDataUrl`/`wasmUrl`/`workerSrc` defaults are relative paths (`../web/...`, `../build/...`) that depend on the original folder layout being preserved exactly.
- **`pdf-viewer/bridge.js` layers our features on top of the stock viewer** — translate-on-click/hover/selection (ported from `content/content-script.js`; not shared/injected, since content scripts don't run on the extension's own pages and `content-script.js` is a classic script while `bridge.js` is an ES module) and the handoff-loading/content-hash logic. It does **not** touch rendering, scrolling, zoom, or highlighting — those are entirely the stock viewer's job. Highlighting uses PDF.js's own native annotation tool (its own toolbar), not a custom feature — nothing in this extension writes or reads PDF annotation data.
  - Before `PDFViewerApplication.run()` reads it, `bridge.js` must set `AppOptions.set("defaultUrl", "")` (via the `webviewerloaded` event, which fires synchronously right before `run()`) — otherwise the stock build falls back to opening its bundled sample PDF, which isn't vendored, since this project always loads via the handoff token.
  - Load order matters: `viewer.mjs` assigns `window.PDFViewerApplication`/`PDFViewerApplicationOptions` at module top level, and `bridge.js`'s `<script>` tag comes after it in `viewer.html` — reversing that order would leave those globals undefined when `bridge.js` runs.
- **PDF vocab is keyed by content hash, not URL**: `pdf:<sha256hex>`, computed in `bridge.js` from the PDF's raw bytes. This flows through the *existing* `vocab[url]`/`cards`/`saveWord()` machinery unchanged (`lib/normalize-url.js#normalizeUrl()` passes a `pdf:...` key through untouched — verified, it's a non-special URL scheme with no hostname/trailing-slash to normalize) — the only change needed was making `saveWord()`'s `SAVE_WORD` handler respect an explicit `entry.url` instead of always overwriting it with `sender.tab.url` (which for a viewer tab would be its own `chrome-extension://.../viewer.html?handoff=...` address).
- **Each `vocab[url]` bucket is a "workbook"** in the side panel's UI (one per page/PDF, plus an "All Words" selection that flattens every workbook's entries into one list) — `sidepanel.js`'s `deleteWorkbook()` is the one place that removes a bucket wholesale, and it must clean up every place that references it: strip the deleted occurrences out of `cards[lemma].occurrenceIds` (dropping any card left with none), and drop `workbookNames[url]` too. Deleting a single entry (`deleteEntry()`) does the `cards` part already; adding a new per-workbook side-effect means checking both functions.
- **Conversation practice (`lib/practice-panel.js`) runs entirely in the side panel** — `webkitSpeechRecognition`/`speechSynthesis` are window-context UI APIs the service worker can't run, so the live session state machine (parse → classify → alternating turns → summary) lives in the panel, with session state deliberately ephemeral (module memory, nothing persisted). Translations still route through `TRANSLATE` messages — one per dialogue line, whose `sourceLang` classifies the line (fr vs en) and whose `translation` doubles as the Mode B reference / display gloss. Same shared-module shape as `settings-panel.js`: exported `initPracticePanel()` with an idempotent listener guard, caller-provided element IDs.
  - **Three modes, inferred from the parsed lines**: A (all French — alternating read-aloud turns), B (mixed — the app reads French, the user speaks the English lines in French), C (all English — every line is the user's to translate aloud, nothing is read to them). C is B with no app lines left, so it shares B's lenient threshold and its "suggested translation" framing; `isTranslateTurn()` (`line.lang === "en"`) is the single test for "the user must produce French here", and it gates scoring leniency, the reference label, and — importantly — never revealing the reference mid-attempt.
  - **Recognition runs `continuous`, and the panel decides when a turn ends** — on ~1.8s of silence, the ✓ Done button, or a hard cap. With `continuous = false` Chrome ends the session at its first final result, which for a spoken sentence is often just the opening word, so the line was scored and failed before the user finished saying it. `e.results` accumulates across the turn, so the transcript is rebuilt from the whole array on each event, not appended to.
  - **Scoring is phonetic, not orthographic** — `lib/fuzzy-match.js#pronunciationScore()` over `phoneticKey()`, a lossy French grapheme→sound folding. Character-Levenshtein (the old `similarity`) marks a learner wrong for spellings French pronounces identically (`parler`/`parlé`/`parlez`), which made the feedback far harsher than the speaking actually was. The folding deliberately over-merges — a false pass costs a learner much less than a false fail. `similarity`/`wordDiff`/`alignWords` are all still exported unchanged; the new functions were added beside them.
  - **The mic level meter is a second, parallel `getUserMedia` stream**, purely decorative and entirely best-effort (any failure just hides the canvas; recognition never waits on it). It exists because `SpeechRecognition` emits nothing at all until it has decoded words, so a wrong input device is indistinguishable from a user who hasn't spoken — which is exactly how it was first hit. Chrome lets the two captures coexist; Web Speech does its own.
- **Mic permission comes from a one-time grant page** (`permission/grant-mic.html`, opened in a tab via `chrome.tabs.create`) — the side panel can't show Chrome's mic prompt itself, but once `getUserMedia({audio:true})` is granted there, recognition works panel-side (same extension origin). No manifest permission involved: `audioCapture` is a Chrome-Apps permission, not an extension one — don't add it. The panel surfaces this as a **modal gate on entering Practice** (`#micModal`), not a button living in the controls — it's one-time setup, so it shouldn't hold permanent space. "Not now" suppresses it for the panel's lifetime, but a real `not-allowed` error overrides that and re-raises it.
- **Additive message contract** — add fields, don't rename or remove.

## Message contract

Request → response:
- `TRANSLATE` `{ text, contextSentence? }` → `{ source, translation, sourceLang, targetLang }`
- `SAVE_WORD` `{ entry }` → `{ ok, count }` — `entry.url` is used as-is if the caller provides one (e.g. `pdf-viewer/bridge.js`'s `pdf:<hash>` key), only falling back to `sender.tab?.url` when absent (regular content-script saves never set it)
- `SAVE_VERB` `{ table }` → `{ ok }`
- `CONJUGATE` `{ verb }` → `{ ok, table } | { error }`
- `OPEN_SIDEPANEL` `{ view, verb?, text? }` → `{ ok }` — `verb` rides along for `view: "conjugation"`, `text` (the selected dialogue) for `view: "practice"`. Delivered to the panel via the `sidepanelIntent` storage key, which the panel consumes both at load (`checkIntent()`) and live via `chrome.storage.onChanged` (so an already-open panel reacts too)
- `SET_HOVER_MODE` `{ enabled }` → `{ ok }` — click-to-translate is always on (no toggle/message for it); hover-dwell is the only optional mode, additive on top of click
- `READ_SELECTION` `{ lang }` → `{ ok }`
- `GET_DUE_REVIEWS` `{}` → `{ items }` — **Phase 3, not yet wired** (no service-worker handler yet; `cards` now has the `dueAt` field this will scan)
- `RECORD_REVIEW` `{ id, correct }` → `{ ok, nextDue }` — **Phase 3, not yet wired** (`background/srs.js` currently only has the box→interval table; promote/demote-on-review logic still to come)
- `LOOKUP_WORDS` `{ words }` → `{ entries: {[word]: {lemma,pos,gender,number,freqRank}|null}, cognates: {[word]: string} }` — batched lexicon + cognate lookup, one call per `content/annotator.js` scan pass
- `GET_SELECTION` `{}` → `{ text }` — sent **popup → the tab's text surface**, for the popup's "🎙 Practice selected text" button (the popup can't read the page itself). Answered by `content/content-script.js` via `chrome.tabs.sendMessage`, and by `pdf-viewer/bridge.js` via a `chrome.runtime.sendMessage` broadcast fallback (it's an extension page, not a content script). **A listener with no selection must not reply at all** — both delivery paths fan out to multiple receivers (every frame in the tab; every open viewer tab) and the first `sendResponse` wins, so an empty answer from an unrelated frame would beat the real one. No responder means the send rejects, which the caller reads as "nothing selected"
- `GET_PAGE_LEVEL` `{}` → `{ level: "A1".."C2"|null, pending? }` — sent **popup → content script directly** (not background-routed; `annotator.js` already holds the per-page data from its own scans). Frequency-rank banding only — v1 deliberately does not factor in the user's known-vocabulary/`cards` data, to keep the metric simple and independent of review history

## Storage schema

```js
{
  vocab: { [url]: [{
    id, cardId, source, translation, sourceLang, targetLang,
    contextSentence, pos, gender, plural, savedAt, url,
    pdfTitle,  // only present when url is "pdf:<sha256hex>" — the picked file's
               // name (or derived from the source URL for "reopen"), since the
               // hash itself isn't human-readable
    pageTitle  // only present for regular (non-PDF) saves — document.title at
               // save time, for the same reason: raw URLs make poor workbook labels
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
  translationCache: { [hash]: { translation, sourceLang, targetLang, ts } },  // 7d TTL, capped
  workbookNames: { [url]: string }  // user-chosen override for a workbook's display
                                     // name (sidepanel.js's rename action) — same
                                     // `url` keys as `vocab`; falls back to
                                     // pdfTitle/pageTitle/hostname when absent
}
```

No PDF annotation/highlight data lives in this extension's storage — that's handled entirely by PDF.js's own native highlight tool inside the vendored viewer (see Conventions above).

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

`pdf-viewer/vendor/` is a vendored third-party application (Mozilla's PDF.js **reference viewer**, Apache-2.0), not generated data — see `vendor/README.txt` for the exact release/files taken and how to upgrade. Unlike an earlier version of this project (which vendored only the display API and hand-built a minimal page against it), the **whole** `web/` + `build/` viewer app is vendored — `viewer.html`/`viewer.mjs`/`viewer.css`, its images/locale(`en-US` only)/`standard_fonts`/`wasm`/`cmaps` assets, and `build/pdf.mjs`/`pdf.worker.mjs`. This project's own code only adds `pdf-viewer/bridge.js` (translate/save/handoff-loading) plus two `<script>`/`<link>` tags inserted into the vendored `viewer.html` — everything else is upstream, unmodified.
