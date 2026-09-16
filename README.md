# L'auxiliaire

A Chrome extension for reading real French — news, essays, PDFs — without
leaving the page to look things up.

Click a word for its translation. Drag across a passage to translate the whole
thing. Save what's worth keeping, with the sentence you met it in. Look up any
verb's full conjugation. Practise a dialogue out loud and get scored on
pronunciation.

**Everything runs on your own machine.** Translation uses Chrome's built-in
on-device `Translator` API — no account, no API key, no server. The one
exception is speech recognition in the Practice tab; see
[Privacy](#privacy) below.

> **Status: working, but pre-release.** Loaded unpacked and used daily by its
> author. Not on the Chrome Web Store. Spaced repetition is designed and has
> its storage schema in place, but the review UI isn't built yet — see
> [`TODO.md`](TODO.md).

---

## Install

Requires **Chrome 138 or newer** — the on-device `Translator` API doesn't exist
before that, and isn't available on mobile Chrome.

```bash
git clone https://github.com/vdixon531/L-auxiliaire.git
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the cloned folder

No build step. No `npm install` needed to *run* it — the repo is the extension.

The first translation of a language pair downloads Chrome's on-device language
pack once (the bubble says so while it happens). Everything after that is
instant and offline.

---

## What it does

### Reading
- **Click any word** for an inline translation. Always on — no mode to enable.
- **Drag across a phrase** and the whole selection is translated. At four
  lines or sentences it shows a preview and a 🌐 Translate button instead, on
  the theory that selecting that much usually means you want to practise it,
  not read a wall of English.
- **Hover-to-translate** is an optional extra on top of clicking (`Alt+T`).
- **Gender colour-coding** tints every noun by grammatical gender. Off by
  default; colours and per-category switches live in Settings.
- **Reading level** — a rough CEFR estimate (A1–C2) for the current page,
  from word-frequency banding.

### Vocabulary
- Every saved word keeps **the sentence you met it in** — never a bare pair.
- Words file themselves into **workbooks**: one per page, one per PDF, plus
  hand-made collections and an "All Words" view across everything.
- Conjugated forms collapse onto their infinitive, so *parle* / *parlé* /
  *parlez* are one card to revise rather than three.
- Type words in by hand, rename and reorder workbooks, **export** to CSV or an
  Anki deck.

### Conjugation
- Any of ~7,000 French verbs, in full, offline. Inflected forms resolve to
  their infinitive, so you can look up a verb as you met it.

### PDFs
- Opens through Mozilla's own PDF.js reference viewer, vendored whole — so
  continuous scroll, zoom, find, print and highlighting are upstream's proven
  code rather than a re-implementation.
- Same click / drag / save behaviour as a web page.
- A PDF's workbook is keyed by **content hash**, so the same file keeps one
  workbook wherever you opened it from.
- **Manual-open only**, by choice: a file picker in the popup, or "reopen this
  PDF" when Chrome's own viewer is showing one. Auto-intercepting every PDF
  would need `declarativeNetRequest` plus broad host permissions.

### Speaking practice
- Select a dialogue (🎙 on the bubble) or paste one into the Practice tab.
- The app reads one side aloud, you speak the other. All-English text becomes
  a translation drill; a passage with no dialogue markers becomes a read-aloud.
- The mic opens on its own after a short countdown — no button to press — and
  the turn ends when you stop talking.
- **Scored on pronunciation, not spelling**: *parler* / *parlé* / *parlez*
  sound identical and are treated as such.
- Scores are held back until the end of the session, so you keep your flow. A
  line that doesn't land at all is replayed once with the French shown.
- Needs a one-time microphone grant. Chrome-only.

### Getting oriented
- A guided tutorial runs on first install and is replayable from Settings.
- In-extension [FAQ](pages/faq.html) and [privacy](pages/privacy.html) pages.
- Light / dark / follow-system, applied across every surface at once.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+T` | Toggle hover-to-translate |
| `Alt+R` | Read the selection aloud |
| `Alt+S` | Translate and save the selection |

Rebindable at `chrome://extensions/shortcuts`.

---

## Privacy

No account, no analytics, no telemetry, no server. Everything the extension
remembers lives in `chrome.storage.local` on your machine and is deleted when
you uninstall it.

**One thing is not on-device:** the Practice tab uses Chrome's Web Speech API,
which transcribes audio through a Google service. Every other feature works
with no network at all. Full detail in [`pages/privacy.html`](pages/privacy.html).

---

## Repository layout

```
manifest.json            MV3 manifest — permissions, commands, entry points

background/              Service worker: owns storage and all external calls
  service-worker.js        message router, storage writes, alarms
  offscreen.html/.js       runs Translator.* (needs a window context a
                           service worker, being a Web Worker, can't provide)
  conjugation.js           Verbiste lookup + lemmatisation (sharded)
  lexicon.js               POS / gender / frequency lookup (sharded)
  detect-lang.js           FR/EN detection, context-sentence aware
  cache.js                 translation cache, 7d TTL, periodic eviction
  srs.js                   Leitner box→interval table (review flow not built)

content/                 Injected into every page
  content-script.js        click / hover / selection translate, the bubble
  annotator.js             gender colouring, CEFR estimate, live config
  popup.css                bubble + annotation styles, all .fla-* namespaced

popup/                   Toolbar popup — settings, PDF entry points
sidepanel/               The workbook: Vocabulary / Conjugation / Practice / Settings
welcome/                 First-run tutorial (a real reproduction of the in-page UI)
permission/              One-time mic grant page
pages/                   Static FAQ and privacy pages

pdf-viewer/
  bridge.js                layers translate/save/handoff onto the vendored viewer
  vendor/                  Mozilla's full PDF.js viewer — see vendor/README.txt

lib/                     Shared ES modules (extension pages only, not content scripts)
  tour.js/.css             spotlight tour engine used by welcome + side panel
  practice-panel.js        conversation-practice state machine
  settings-panel.js        the settings UI shared by popup and side panel
  theme.css, theme-mode.js design tokens and light/dark switching
  fuzzy-match.js           French phonetic folding + pronunciation scorer
  normalize-url.js         canonicalises URLs used as vocab keys
  pdf-handoff.js           IndexedDB handoff of PDF bytes to the viewer
  flip.js/.css             card-flip animation for vocab entries

data/                    Bundled lookup data (see NOTICE.md for provenance)
  verbs/, lemmas/          conjugations + inflected→infinitive, sharded a–z
  lexicon/                 surface form → {lemma, pos, gender, number, freqRank}
  cognates.json            hand-curated FR→EN cognate map
  Lexique4/                source TSV for the lexicon build

scripts/                 Build and guard scripts (Node, run by hand)
fonts/                   Bundled webfonts — see fonts/README.txt
icons/
```

## Architecture notes

[`CLAUDE.md`](CLAUDE.md) is the real architecture document — conventions, the
message contract, the storage schema, the MV3 traps, and the reasoning behind
decisions that look odd until you know why. It's written as instructions for an
AI agent working in this repo, but it's the most complete and most current
description of how the thing fits together, and it's maintained as the code
changes. **Read it before making a non-trivial change.**

Two things worth knowing up front:

- **The service worker owns state and all external calls.** Content scripts and
  the side panel are UI only.
- **There's no build step and no framework.** Vanilla ES modules, loaded
  unpacked. `scripts/` holds Node helpers you run by hand, not a pipeline.

## Development

```bash
npm run check          # all guards: syntax, undefined refs, contrast
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow, how to
regenerate the bundled data, and what the guard scripts actually check.

## Roadmap

Open items and the decision log live in [`TODO.md`](TODO.md).

The near-term one is **spaced repetition** — `cards` already carries the Leitner
fields (`box`, `dueAt`, `correctStreak`), `background/srs.js` has the interval
table, and `GET_DUE_REVIEWS` / `RECORD_REVIEW` are specified in the message
contract. What's missing is the review UI and the handlers behind those two
messages.

## Licence

**GPL-2.0-or-later** — see [`LICENSE`](LICENSE).

This is a consequence of the bundled Verbiste conjugation data, which is
GPL-2.0-or-later and which the extension ships in derived form. Third-party
components and their licences are listed in [`NOTICE.md`](NOTICE.md).
