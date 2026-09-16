# Contributing

Thanks for looking. This is a personal project that got big enough to be worth
sharing — it's not a polished OSS operation, and the notes below are meant to
save you from the traps rather than to impose process.

## Read this first

[`CLAUDE.md`](CLAUDE.md) is the architecture document. It's written as
instructions for an AI agent working in this repo, which is an unusual format
for a human to read, but it is the most complete and most current description
of how the extension fits together: the conventions, the message contract, the
storage schema, the MV3 traps, and — most usefully — *why* several
counter-intuitive decisions are the way they are.

It is kept current as the code changes. **If you change something it
describes, update it in the same commit.** A convention documented there and
then quietly broken in code is worse than no document.

## Getting set up

```bash
git clone https://github.com/vdixon531/L-auxiliaire.git
cd L-auxiliaire
```

Load it in Chrome (138+): `chrome://extensions` → Developer mode → **Load
unpacked** → select the folder.

There's no build step, no bundler and no runtime dependency. **`npm install`
is not required to run the extension** — the repo *is* the extension, and
`package.json` exists only to name the guard and build scripts. It has no
dependencies, so `npm install` does nothing useful.

After changing code: hit the reload icon on `chrome://extensions`, then
**reload any tab you want the content script to run in**. Content scripts do
not re-inject into already-open tabs.

## Before you push

```bash
npm run check
```

Three guards, all of which must pass:

| Script | What it catches |
|---|---|
| `check:syntax` | Files that don't parse. Handles the ESM/CJS split — `node --check` picks its dialect from the file extension, and everything here is `.js`, so ES modules are copied to a temp `.mjs` first. Without that you get "Unexpected token 'export'" on perfectly good files. |
| `check:refs` | Calls to functions that don't exist. `node --check` only proves a file *parses*; it says nothing about whether what it calls is defined. This exists because an edit once silently swallowed two function declarations and every other check still passed — it surfaced at runtime as a blank word list. |
| `check:contrast` | Colour contrast in both light and dark, that the duplicated dark-mode blocks stay in sync, and that `content/popup.css`'s copy of the design tokens still matches `lib/theme.css`. |

`check:contrast` encodes two rules that are easy to trip:

- **Small letterspaced caps are held to 6:1**, not WCAG AA's 4.5:1 — that
  floor is calibrated for normal-weight body text and is too lenient for the
  tab labels and `fr`/`en` chips.
- **Nothing may use `opacity` to make text quiet.** Opacity compounds against
  whatever surface is behind it and silently drops an already-faint ink under
  3:1. Use a lighter ink token instead. This is how the first dark palette
  became unreadable.

None of the guards are a test suite. There isn't one — **everything is
verified by hand in a real browser**, and most of `TODO.md` is a record of
things that only showed up that way.

## The shape of the codebase

Vanilla ES modules, no framework, no TypeScript. A few things that will bite
you if you assume otherwise:

- **The service worker owns state and every external call.** Content scripts
  and the side panel are UI only. The single exception is
  `background/offscreen.js`, which runs the `Translator.*` calls because that
  API needs a window context a service worker (being a Web Worker) can't
  provide.
- **A service worker can die between events.** Persist to `chrome.storage`;
  never hold canonical state in a module variable.
- **Content scripts can't import extension modules.** That's why
  `content/annotator.js` keeps its own copy of some constants that `lib/`
  otherwise owns, and why `pdf-viewer/bridge.js` *ports* interaction logic
  from `content/content-script.js` rather than sharing it. Where you see
  duplication between those files it is usually deliberate — check `CLAUDE.md`
  before "fixing" it.
- **The content script runs on `<all_urls>`.** Be defensive; never break a
  host page. All injected CSS is namespaced `.fla-*`.
- **`chrome.runtime.sendMessage` fans out to every other extension context.**
  Filter on `msg.type` before acting.

## Style

There's no linter or formatter config, because there's no build step to hang
one off. Match the file you're editing: 2-space indent, double quotes,
semicolons, `camelCase`.

The comment convention is worth matching deliberately: **comments explain why,
not what.** The codebase is dense with notes about decisions that look wrong
until you know the constraint behind them — a CSS containing block, a race in
a relay between two documents, a Chrome API that needs a user gesture. Those
notes are the reason the project is maintainable. Adding one when you work
something out the hard way is the single most valuable thing you can
contribute.

## Regenerating bundled data

You only need this if you're changing how the lookup data is built. The
generated output is committed, so a fresh clone works without running any of it.

```bash
npm run build:verbs      # data/verbs/, data/lemmas/  <- scripts/verbiste-source/*.xml
npm run build:lexicon    # data/lexicon/              <- data/Lexique4/Lexique4.tsv
npm run build:icons      # icons/icon-{16,48,128}.png
```

Both data sets are sharded by first letter so a lookup loads ~1/26th of the
data rather than all of it. `scripts/shard-writer.js` holds the shared
`normalize()` / `shardKeyOf()` helpers — and `background/conjugation.js` and
`background/lexicon.js` each keep their own runtime copy of that same logic,
because they're ES modules and the build scripts are CommonJS. **All copies
must match exactly**, or a word will look up a shard that was never built for
it.

The Verbiste XML is committed. The Lexique TSV is committed too, but it's 32MB
— see [`NOTICE.md`](NOTICE.md) for its provenance and an open question about
its redistribution terms.

## Upgrading PDF.js

Re-vendor `web/` and `build/` **wholesale** from the release zip — don't
cherry-pick files. `viewer.mjs`'s internal defaults (`cMapUrl`,
`standardFontDataUrl`, `wasmUrl`, `workerSrc`) are relative paths that depend
on the exact folder layout. Then re-apply the two `L'auxiliaire:`-marked lines
in `web/viewer.html` that load `bridge.js`. Full procedure:
[`pdf-viewer/vendor/README.txt`](pdf-viewer/vendor/README.txt).

## Licensing

The project is **GPL-2.0-or-later**, and that isn't a preference — it follows
from the bundled Verbiste conjugation data, which is GPL-2.0-or-later and
which the extension ships in derived form (`data/verbs/`, `data/lemmas/`).

**This constrains what you can add.** A dependency under a GPL-incompatible
licence can't go in. If you add anything third-party, add it to
[`NOTICE.md`](NOTICE.md) in the same commit, with its licence and where it
came from.

By contributing you agree your contribution is licensed the same way.

## Reporting things

Open an issue. For a bug, the two things that actually help are **your Chrome
version** (`chrome://version`) and **which surface it happened on** — a web
page, the PDF viewer, the side panel, or the popup — because those are four
different execution contexts with genuinely different constraints.
