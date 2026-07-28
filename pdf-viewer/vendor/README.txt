Vendored from mozilla/pdf.js v6.1.200 (Apache-2.0), downloaded from:
https://github.com/mozilla/pdf.js/releases/download/v6.1.200/pdfjs-6.1.200-dist.zip

This vendors Mozilla's FULL reference viewer application (not just the
display API) — a hand-built minimal viewer was tried first and its custom
render pipeline broke twice (once for single-page navigation, once for a
continuous-scroll rewrite), both times reimplementing things this stock
viewer already does correctly: proper virtualized continuous scroll, zoom,
and a pixel-correct native highlight annotation tool.

Folder layout is preserved EXACTLY as shipped in the dist zip, because
viewer.mjs's own internal defaults (cMapUrl, standardFontDataUrl, wasmUrl,
workerSrc — all in the AppOptions defaults table near the top of viewer.mjs)
are relative paths like "../web/cmaps/" and "../build/pdf.worker.mjs" that
depend on this exact structure. Do not flatten or reorganize these folders.

  build/pdf.mjs             <- build/pdf.mjs         (display API)
  build/pdf.worker.mjs      <- build/pdf.worker.mjs   (parsing, off-thread)
  web/viewer.html           <- web/viewer.html        (the actual page —
                                                        edited: added a <link>
                                                        for content/popup.css
                                                        and a <script> for
                                                        ../../bridge.js, see
                                                        the "L'auxiliaire:"
                                                        comments in the file)
  web/viewer.mjs            <- web/viewer.mjs         (the whole reference
                                                        viewer application —
                                                        toolbar, sidebar, find
                                                        bar, zoom, print,
                                                        annotation editor —
                                                        UNMODIFIED)
  web/viewer.css            <- web/viewer.css
  web/images/               <- web/images/            (toolbar icons)
  web/standard_fonts/       <- web/standard_fonts/     (fallback fonts)
  web/wasm/                 <- web/wasm/               (JBIG2/OpenJPEG/QCMS/
                                                        quickjs decoders, for
                                                        scanned/faxed/JPEG2000/
                                                        ICC-color/scripted PDFs)
  web/cmaps/                <- web/cmaps/              (predefined Adobe
                                                        CMaps, non-Latin text)
  web/locale/locale.json    <- web/locale/locale.json
  web/locale/en-US/         <- web/locale/en-US/       (only this locale
                                                        vendored — the other
                                                        ~90 languages are
                                                        ~2.4MB combined and
                                                        this extension is
                                                        English/French-focused;
                                                        l10n falls back
                                                        gracefully without them)

Source maps (.map files) were deliberately NOT vendored — only useful for
debugging PDF.js's own internals, not something this extension ships to end
users. Also not vendored: web/viewer.html's sample PDF
(compressed.tracemonkey-pldi-09.pdf), web/debugger.mjs/.css (a dev tool),
web/iccs/ (used only alongside a full color-management workflow this
extension doesn't need), pdf.sandbox.mjs (PDF-embedded JavaScript execution —
not needed for reading/translating).

pdf-viewer/bridge.js (a sibling of this vendor/ directory, NOT part of the
vendored code) adds this extension's translate/save/conjugate/workbook
features on top via the DOM and PDFViewerApplication's public API/event bus —
see CLAUDE.md's Conventions section for how it hooks in (defaultUrl override,
initializedPromise, open({data})).

To upgrade: download a newer pdfjs-<version>-dist.zip and re-extract this
same file set into these same paths — re-apply the two viewer.html edits
(the "L'auxiliaire:" comments mark them) since a fresh copy will overwrite
them. No build tooling involved.
