# Third-party notices

L'auxiliaire is **GPL-2.0-or-later** (see [`LICENSE`](LICENSE)) and bundles the
work below. Each remains under its own licence.

The project's licence follows from Verbiste: that data is GPL-2.0-or-later, the
extension ships a derived form of it, and copyleft propagates to the combined
work. A dependency under a GPL-incompatible licence therefore can't be added.

| Component | Licence | Where |
|---|---|---|
| [Verbiste](https://perso.b2b2c.ca/~sarrazip/dev/verbiste.html) — conjugations | GPL-2.0-or-later | `scripts/verbiste-source/*.xml` (source), `data/verbs/`, `data/lemmas/` (derived) |
| [PDF.js](https://github.com/mozilla/pdf.js) v6.1.200 — viewer | Apache-2.0 | `pdf-viewer/vendor/` |
| [Lexique 4](http://www.lexique.org/) — lexical database | CC BY-SA 4.0 | `scripts/lexique-source/Lexique4.tsv` (source), `data/lexicon/` (derived) |
| EB Garamond, Public Sans | SIL OFL 1.1 | `fonts/*.woff2` |

## Verbiste

By Pierre Sarrazin. Obtained from the [verbecc](https://github.com/bretttolbert/verbecc)
mirror of the upstream XML. ~7,000 verbs, 146 conjugation templates. This is the
component that sets the project's licence.

## PDF.js

Mozilla's **full reference viewer**, vendored whole. Two lines were added to
`pdf-viewer/vendor/web/viewer.html` (a `<link>` and a `<script>`) to load this
project's `bridge.js`, marked with `L'auxiliaire:` comments — everything else
under `vendor/` is unmodified upstream. See
[`pdf-viewer/vendor/README.txt`](pdf-viewer/vendor/README.txt) for the file
manifest and upgrade procedure.

PDF.js bundles further components whose licence texts ship alongside them:
Adobe CMaps, Foxit and Liberation fonts (`vendor/web/standard_fonts/`), and the
JBIG2, OpenJPEG and QCMS decoders (`vendor/web/wasm/`).

## Lexique 4

By Boris New & Christophe Pallier. **CC BY-SA 4.0** — the share-alike term
applies to the derived `data/lexicon/` shards as well as the source table. Full
credits and the licence statement are in
[`scripts/lexique-source/README-Lexique.txt`](scripts/lexique-source/README-Lexique.txt),
committed alongside the data. Cite as:

> New, B., Pallier, C., Ferrand, L., & Matos, R. (2001). Une base de données
> lexicales du français contemporain sur internet: LEXIQUE. *L'Année
> Psychologique, 101*, 447–462.

## Fonts

Latin subset only, from Google Fonts. Bundled rather than linked because a
content script's stylesheet is subject to the *host page's* CSP, which would
block a Google Fonts request on many real sites. See
[`fonts/README.txt`](fonts/README.txt) to refresh them.

---

**Not bundled:** no analytics, telemetry, advertising SDK or crash reporter,
and no runtime network dependency. Translation is on-device via Chrome's
`Translator` API. The one exception is speech recognition in the Practice tab,
which uses Chrome's Web Speech API and is not on-device — see
[`pages/privacy.html`](pages/privacy.html).
