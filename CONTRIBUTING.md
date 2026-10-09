# Contributing

A personal project that got big enough to share. The notes below exist to save
you from the traps, not to impose process.

## Read this first

[`CLAUDE.md`](CLAUDE.md) is the architecture document — conventions, the
message contract, the storage schema, the MV3 traps, and *why* several
counter-intuitive decisions are the way they are. It's written as instructions
for an AI agent, which is an odd format to read, but it's the most complete and
most current description of how the extension fits together.

**If you change something it describes, update it in the same commit.** A
convention documented there and quietly broken in code is worse than no
document.

## Setup

```bash
git clone https://github.com/vdixon531/L-auxiliaire.git
```

Chrome 138+ → `chrome://extensions` → Developer mode → **Load unpacked** →
select the folder.

No build step, no bundler, no runtime dependency. **`npm install` is not
required** — the repo *is* the extension. `package.json` exists only to name
the scripts and has no dependencies.

After changing code: reload on `chrome://extensions`, then **reload any tab you
want the content script to run in** — content scripts don't re-inject into
already-open tabs.

## Before you push

```bash
npm run check
```

| Script | Catches |
|---|---|
| `check:syntax` | Files that don't parse. Copies ES modules to a temp `.mjs` first — `node --check` picks its dialect from the file extension, and everything here is `.js`, so without that you get "Unexpected token 'export'" on good files. |
| `check:refs` | Calls to functions that don't exist. Exists because an edit once silently swallowed two function declarations; every other check passed and it surfaced at runtime as a blank word list. |
| `check:contrast` | Colour contrast in both themes, that the duplicated dark-mode blocks stay in sync, and that `content/popup.css`'s token copy still matches `lib/theme.css`. |

Two rules `check:contrast` encodes that are easy to trip: small letterspaced
caps are held to **6:1** (WCAG AA's 4.5:1 is calibrated for body text), and
**nothing may use `opacity` to make text quiet** — it compounds against the
surface and silently drops faint ink under 3:1. Use a lighter ink token.

None of these is a test suite. There isn't one — **everything is verified by
hand in a real browser**, which is why [`TODO.md`](TODO.md) opens with
validation debt.

## Style

No linter or formatter, because there's no build step to hang one off. Match
the file you're editing: 2-space indent, double quotes, semicolons, camelCase.

The comment convention is worth matching deliberately: **comments explain why,
not what.** This codebase is dense with notes about decisions that look wrong
until you know the constraint behind them — a CSS containing block, a race
between two documents, an API that needs a user gesture. Adding one when you
work something out the hard way is the most valuable thing you can contribute.

## Regenerating bundled data

Only needed if you're changing how the lookup data is built; the generated
output is committed, so a fresh clone works without running any of it.

```bash
npm run build:verbs      # data/verbs/, data/lemmas/  <- scripts/verbiste-source/
npm run build:lexicon    # data/lexicon/              <- scripts/lexique-source/
npm run build:icons      # icons/
```

Both sets are sharded by first letter so a lookup loads ~1/26th of the data.
`scripts/shard-writer.js` holds the shared helpers — and `background/conjugation.js`
and `background/lexicon.js` each keep their own runtime copy of that same
logic, because they're ES modules and the build scripts are CommonJS. **All
copies must match exactly**, or a word looks up a shard that was never built
for it.

Raw source data lives under `scripts/`, never `data/` — `data/` holds only what
ships to the browser. Chrome loads the whole extension directory, so anything
parked in `data/` gets loaded whether the extension reads it or not.

## Upgrading PDF.js

Re-vendor `web/` and `build/` **wholesale** from the release zip, then re-apply
the two `L'auxiliaire:`-marked lines in `web/viewer.html`. Don't cherry-pick
files — `viewer.mjs`'s internal defaults are relative paths that depend on the
exact folder layout. Procedure:
[`pdf-viewer/vendor/README.txt`](pdf-viewer/vendor/README.txt).

## Licensing

The project is **GPL-2.0-or-later**, and that isn't a preference — it follows
from the bundled Verbiste data (see [`NOTICE.md`](NOTICE.md)). **A dependency
under a GPL-incompatible licence can't go in.** Anything third-party you add
goes in `NOTICE.md` in the same commit, with its licence and origin.

By contributing you agree your contribution is licensed the same way.

## Reporting

Open an issue. The two things that actually help: your **Chrome version**
(`chrome://version`) and **which surface** it happened on — a web page, the PDF
viewer, the side panel, or the popup. Those are four different execution
contexts with genuinely different constraints.
