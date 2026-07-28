Vendored from mozilla/pdf.js v6.1.200 (Apache-2.0), downloaded from:
https://github.com/mozilla/pdf.js/releases/download/v6.1.200/pdfjs-6.1.200-dist.zip

Files taken (from the dist zip's build/ and web/ folders):
  pdf.mjs          <- build/pdf.mjs         (display API: getDocument, TextLayer, GlobalWorkerOptions)
  pdf.worker.mjs   <- build/pdf.worker.mjs  (parsing, runs off-thread)
  pdf_viewer.css   <- web/viewer.css        (only .textLayer/.annotationLayer rules are actually
                                              used here — vendored whole rather than hand-extracted
                                              to avoid drift on future version bumps; the toolbar/
                                              sidebar rules it also contains are unused dead weight,
                                              not a correctness concern)
  cmaps/           <- web/cmaps/            (predefined Adobe CMaps, for non-Latin/custom-encoded PDFs)

Source maps (.map files, ~8MB combined) were deliberately NOT vendored — they're
only useful for debugging PDF.js's own internals, not something this extension
ships to end users.

Not vendored at all: web/pdf_viewer.mjs and friends (Mozilla's own toolbar/
viewer-widget UI) — this extension's viewer builds its own minimal page directly
against the display API (pdf-viewer/viewer.js), not Mozilla's prebuilt viewer.

To upgrade: download a newer pdfjs-<version>-dist.zip and repeat the same
copy step. No build tooling involved.
