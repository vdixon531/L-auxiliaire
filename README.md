# L'auxiliaire

A Chrome extension for learning French while you browse. Translate on hover or select, hear it spoken, save words with their context sentence to a per-page workbook, view verb conjugations, and review with spaced repetition.

## Feature summary

**Core translation**
- Click any word to translate it — always on, no toggle needed
- Hover mode (optional): automatic translation after a short pause, on top of click
- Selection popup: highlight a phrase or sentence to translate it, with play buttons for both languages (French always available)
- All translations run on-device via Chrome's built-in Translator API (Chrome 138+) — no account, no API key, no network round-trip

**Vocabulary workbook**
- Save any word or phrase — automatically captures the surrounding sentence as context
- Per-URL workbooks (each article gets its own list) plus an "All" aggregate view
- Search, CSV export, Anki export
- For PDFs: workbook keyed by file content, so downloaded copies share vocab

**Verb conjugations**
- Auto-detect infinitives (and conjugated forms via lemmatization)
- Full conjugation table from bundled Verbiste dataset (~7000 verbs)
- Save whole tables to a separate verbs workbook

**Reading aids (Phase 2)**
- Gender + plural color coding — customizable colors for masculine, feminine, plural nouns
- Frequency dimming — common words (top 1000) fade so rare words stand out
- Cognate highlighting — obvious English-French cognates get a subtle underline
- Reading level estimate — CEFR badge per page based on your known vocabulary

**Retention (Phase 3)**
- Spaced repetition (Leitner box system) — review words right before you'd forget them
- Three review formats: French → English recognition, English → French typed (fuzzy-matched with accent tolerance), audio → meaning
- Sentence mining mode — one click saves an entire sentence plus every unknown word inside it
- Light gamification (opt-in): day streak, words reviewed today, no notifications

**PDF support (Phase 4)**
- Custom PDF viewer via PDF.js — same selection/hover behavior as web pages
- Per-PDF workbook keyed by content hash
- Overlay annotations that persist across sessions

**Stretch goals**
- Voice input pronunciation practice
- YouTube subtitle overlay with clickable words
- Wiktionary definitions in save flow
- Notion sync

## Setup

1. Clone/open in VS Code.
2. Make sure you're on **Chrome 138 or newer** — translation runs on Chrome's
   built-in on-device Translator API, which doesn't exist on older versions
   or on mobile Chrome. No signup, no API key.
3. Load the extension:
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** and select this folder
4. First translation of a new language pair (fr→en or en→fr) downloads that
   on-device language pack once — the bubble shows "Downloading language
   pack (one-time)…" while that happens.

Previously this project used DeepL/Google Cloud Translate and required an API
key; that's gone. (Also worth knowing regardless: DeepL discontinued its free
API tier for new signups as of mid-2026, so that path is no longer viable
even if you wanted it back.)

## Keyboard shortcuts

- `Alt+T` — toggle hover-to-translate mode
- `Alt+R` — read selection aloud in French
- `Alt+S` — save selection to vocab

## Getting bundled data ready

The MVP ships with placeholder data. Run these conversions before building out Phase 1:

1. **Verbiste conjugation data** (~7000 verbs) — done
   - Source XML lives in `scripts/verbiste-source/` (`conjugations-fr.xml`, `verbs-fr.xml`), a mirror of Pierre Sarrazin's Verbiste data maintained at https://github.com/bretttolbert/verbecc (GPL-2.0-or-later; original at https://perso.b2b2c.ca/~sarrazip/dev/verbiste.html).
   - Regenerate with `node scripts/build-verbiste.js` (7011 verbs, 146 conjugation templates) — writes sharded output to `data/verbs/<letter>.json` and `data/lemmas/<letter>.json`, not a single file, so a lookup only loads ~1/26th of the dataset instead of all of it.

2. **Lexique.org lexicon** (~30k words — POS, gender, number, frequency) — done
   - Source TSV lives at `data/Lexique4/Lexique4.tsv` (download from http://www.lexique.org/, not checked in).
   - Regenerate with `node scripts/build-lexicon.js` — writes sharded output to `data/lexicon/<letter>.json`, same scheme as the verb data above.

3. **Cognate list** (~360 hand-picked entries) — done
   - `data/cognates.json` is hand-curated, not generated — there's no reliable way to tell true cognates from false friends (`actuellement`/actually, `librairie`/library, ...) using frequency or POS data alone.

## Roadmap

See `CLAUDE.md` for the detailed weekend-by-weekend build order and all technical decisions.

- **Weekend 1**: Core MVP — translate, save with context, conjugation, click/hover translate, cache
- **Weekend 2**: Reading aids — color coding, frequency dimming, cognates, CEFR
- **Weekend 3**: Retention — spaced repetition, sentence mining, gamification
- **Weekend 4**: PDF support via PDF.js

## Architecture

```
manifest.json             — MV3 manifest, permissions, commands
background/
  service-worker.js       — storage, message router, spawns the offscreen doc
  offscreen.html/.js      — runs Translator.* (needs a window context the
                            service worker, a Web Worker, can't provide)
  conjugation.js          — Verbiste lookup + lemmatization
  detect-lang.js          — FR/EN detection (context-sentence aware)
  lexicon.js              — POS/gender/frequency lookup (shard-cache, mirrors conjugation.js)
  srs.js                  — Leitner box→interval table (full review flow: Phase 3)
  cache.js                — Translation cache
content/
  content-script.js       — Selection, click/hover translate, bubble
  annotator.js            — Color coding, dimming, cognate underlines, CEFR estimate
  context.js              — Sentence extraction from DOM
  popup.css               — Floating bubble + annotation styles (.fla-* namespaced)
popup/                    — Toolbar icon popup — settings, color pickers
sidepanel/                — Vocab / Conjugation / Review / Progress tabs
data/
  verbs/<letter>.json     — conjugation tables, sharded by infinitive's first letter
  lemmas/<letter>.json    — conjugated form -> infinitive, sharded by its first letter
  lexicon/<letter>.json   — surface form -> {lemma,pos,gender,number,freqRank}, same sharding
  cognates.json           — hand-curated English-French cognate map
lib/
  fuzzy-match.js          — Levenshtein for review + pronunciation
  normalize-url.js        — Canonicalizes URLs used as vocab keys
```

## Storage

All data lives in `chrome.storage.local`. No cloud sync yet. See `CLAUDE.md` for the storage schema.

## Notes

- Manifest V3 — no inline scripts, service worker uses ES modules
- Web Speech API for TTS (works everywhere) and STT (Chrome-only)
- Bundle size target: under ~10MB gzipped total
