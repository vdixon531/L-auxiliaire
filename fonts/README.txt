Bundled webfonts (latin subset only — French needs no more than that).

Both families are SIL Open Font License 1.1, taken from Google Fonts:

  eb-garamond-latin.woff2         EB Garamond v33, normal, variable wght 400..700
  eb-garamond-latin-italic.woff2  EB Garamond v33, italic, variable wght 400..600
  public-sans-latin.woff2         Public Sans v21, normal, variable wght 400..700
  public-sans-latin-italic.woff2  Public Sans v21, italic, variable wght 400..600

They are bundled rather than linked because a content script's stylesheet is
subject to the host page's CSP — a Google Fonts <link> would be blocked on
plenty of real sites, and the extension has no network dependency otherwise.
Declared in lib/theme.css (and, scoped, in content/popup.css) and exposed via
manifest.json's web_accessible_resources so the in-page bubble can use them.

To refresh: request the css2 URL with a browser User-Agent, take the woff2 whose
unicode-range starts U+0000-00FF (the "latin" subset), and keep these filenames.
