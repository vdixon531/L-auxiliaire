/**
 * Design-token guard. Run: node scripts/check-contrast.js
 *
 * Three jobs, all of which are silent-bug traps this project is prone to:
 *
 *  1. Every text/surface pairing the UI actually renders clears its contrast
 *     floor, in BOTH colour schemes. A palette can pass a casual eyeball in
 *     light mode and be unreadable in dark, which is exactly what happened the
 *     first time this theme landed.
 *  2. content/popup.css's scoped copy of the tokens hasn't drifted from
 *     lib/theme.css. The bubble can't share the theme file (a content script
 *     must not define custom properties at :root — that leaks the palette onto
 *     the host page), so the duplication is deliberate and has to be checked.
 *  3. A "highlight" surface (a tint box sitting on a card — the saved-word
 *     context quote, the mic hint, an error block) is actually visible AS A
 *     SURFACE, not just legible once you know it's there. Text-contrast checks
 *     alone miss this entirely: --fla-accent-tint's dark value once measured a
 *     comfortable 12:1 for the text on it while being the exact same luminance
 *     as the card behind it (ratio 1.00) — a low-chroma dark tint carries its
 *     hue so faintly that it read as a slightly odd smudge, not a highlighted
 *     box. Light-theme tints get away with far less separation than dark ones
 *     need, because hue/chroma differences collapse hard at low lightness —
 *     don't reuse a light-mode separation figure as the dark-mode target.
 *
 * Small uppercase labels are held to 6:1 rather than the 4.5:1 WCAG AA floor —
 * 9-11px letterspaced caps are the hardest thing on these surfaces, and AA's
 * threshold is calibrated for normal-weight body text.
 *
 * Note the absence of any opacity here: nothing in the UI may fade text to
 * make it quiet, because opacity compounds against the surface and silently
 * drops an already-faint ink under 3:1. Use a lighter ink token instead.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function tokens(css, blockRe) {
  const block = css.match(blockRe);
  if (!block) throw new Error("token block not found: " + blockRe);
  const out = {};
  for (const [, k, v] of block[1].matchAll(/(--fla-[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[k] = v;
  }
  return out;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// [foreground token, background token, where it renders, minimum ratio]
const PAIRS = [
  ["--fla-ink", "--fla-bg", "body text on the page ground", 7],
  ["--fla-ink", "--fla-card", "body text on a card", 7],
  ["--fla-heading", "--fla-bg", "serif headline (h1, verb, workbook title)", 7],
  ["--fla-heading", "--fla-card", "saved word, bubble source text", 7],
  ["--fla-ink-muted", "--fla-bg", "secondary text on ground", 4.5],
  ["--fla-ink-muted", "--fla-card", "translation line, hints on a card", 4.5],
  ["--fla-ink-faint", "--fla-bg", "hint / placeholder / empty state", 4.5],
  ["--fla-ink-faint", "--fla-card", "workbook count, entry-origin, delete x", 4.5],
  ["--fla-ink-faint", "--fla-sunken", "faint text on a sunken chip", 4.5],
  ["--fla-ink-faint", "--fla-card", "inactive tab (11px caps)", 6],
  ["--fla-ink-faint", "--fla-card", "practice score / gloss (11px)", 6],
  ["--fla-ink-faint", "--fla-card", "unspoken word (.lw.pending)", 4.5],
  ["--fla-primary", "--fla-bg", "active tab label + underline", 4.5],
  ["--fla-on-primary", "--fla-primary", "filled button label", 4.5],
  ["--fla-on-primary", "--fla-primary-soft", "filled button label, hover", 4.5],
  ["--fla-ink", "--fla-primary-tint", "active workbook / current practice line", 4.5],
  ["--fla-ink-muted", "--fla-variant", "language chip (fr/en), 9px caps", 6],
  ["--fla-ink-muted", "--fla-sunken", "speak button glyph", 4.5],
  ["--fla-ink", "--fla-raised", "button hover", 4.5],
  ["--fla-accent", "--fla-card", "pass score, revealed French", 4.5],
  ["--fla-accent", "--fla-bg", "pass score on ground", 4.5],
  ["--fla-ink-muted", "--fla-accent-tint", "context sentence in its quote block", 4.5],
  ["--fla-accent-deep", "--fla-accent-tint", "live-matched word (.lw.ok)", 4.5],
  ["--fla-warn", "--fla-warn-tint", "near-miss word (.dw.near), mic hint", 4.5],
  ["--fla-error", "--fla-error-tint", "missed word (.dw.miss), .error box", 4.5],
  ["--fla-error", "--fla-card", "delete hover, error text", 4.5],
  // Tutorial (lib/tour.css, welcome/welcome.css). The callout sits on
  // --fla-overlay, not --fla-card, so it reads as floating above the page.
  ["--fla-ink", "--fla-overlay", "tour callout body", 7],
  ["--fla-ink-muted", "--fla-overlay", "tour step counter, Back/Skip labels", 4.5],
  ["--fla-heading", "--fla-overlay", "tour callout title", 7],
  ["--fla-on-primary", "--fla-primary", "tour Next button", 4.5],
  ["--fla-ink", "--fla-sunken", "tour keyboard cap (kbd)", 4.5],
  ["--fla-ink", "--fla-card", "tour callout body emphasis, chapter name", 7],
  ["--fla-ink-muted", "--fla-card", "tour callout body, chapter description", 4.5],
  ["--fla-ink-faint", "--fla-card", "tour step counter (11px caps)", 6],
  // Disabled controls. A BAND, not a floor: too low and you can't read which
  // control is unavailable, too high and it doesn't read as disabled at all —
  // which is what happened when this reused --fla-ink-faint at 6:1.
  ["--fla-ink-disabled", "--fla-card", "disabled button label", 2, 3.5],
  ["--fla-ink-disabled", "--fla-bg", "disabled button on the page ground", 2, 3.5],
  ["--fla-ink-disabled", "--fla-sunken", "disabled control on a sunken field", 2, 3.5],
  // The error block in the bubble: text on its tint, and the "!" badge, which
  // inverts the same pair.
  ["--fla-error", "--fla-error-tint", "error block text", 4.5],
  ["--fla-error-tint", "--fla-error", "error badge glyph on its dot", 4.5],
  ["--fla-on-primary", "--fla-accent", "confirmation pill (Saved ✓)", 4.5],
  ["--fla-on-primary", "--fla-error", "error pill", 4.5],
];

// [tinted surface, surface it sits on, where, minimum separation]. DARK ONLY
// — the light theme's tints separate from white at only 1.10-1.29 and read
// completely fine there, because a pale, high-lightness colour still carries
// its hue clearly (chroma does the work). Applying the same floor to light
// would fail tints nobody has ever found hard to see; the failure mode this
// check exists for — a tint whose hue has collapsed into invisibility — is
// specifically a low-lightness problem, so only dark mode needs the check.
const SURFACES = [
  ["--fla-accent-tint", "--fla-card", "context-sentence quote block, .lw.ok pill", 1.15],
  ["--fla-warn-tint", "--fla-card", "mic hint, near-miss word background", 1.15],
  ["--fla-error-tint", "--fla-card", "error block, missed-word background", 1.15],
  ["--fla-primary-tint", "--fla-card", "active workbook row, current practice line", 1.1],
  ["--fla-overlay", "--fla-card", "tour callout / popup menu above a card", 1.1],
];

function auditSurfaces(label, map) {
  console.log(`\n=== ${label} surfaces ===`);
  let failures = 0;
  for (const [tint, surface, where, min] of SURFACES) {
    if (!map[tint] || !map[surface]) {
      console.log(`  ??   missing token ${tint} / ${surface}`);
      failures++;
      continue;
    }
    const v = ratio(map[tint], map[surface]);
    const ok = v >= min;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${v.toFixed(2).padStart(5)} (want ${min.toFixed(2)}+)  ` +
        `${tint.padEnd(18)} vs ${surface.padEnd(12)} ${where}`
    );
  }
  return failures;
}

function audit(label, map) {
  console.log(`\n=== ${label} ===`);
  let failures = 0;
  for (const [fg, bg, where, want, max] of PAIRS) {
    if (!map[fg] || !map[bg]) {
      console.log(`  ??   missing token ${fg} / ${bg}`);
      failures++;
      continue;
    }
    const v = ratio(map[fg], map[bg]);
    const ok = v >= want && (max === undefined || v <= max);
    if (!ok) failures++;
    const target = max === undefined ? `want ${want.toFixed(1)}` : `want ${want.toFixed(1)}-${max.toFixed(1)}`;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${v.toFixed(2).padStart(5)} (${target})  ` +
        `${fg.padEnd(18)} on ${bg.padEnd(20)} ${where}`
    );
  }
  return failures;
}

const theme = fs.readFileSync(path.join(ROOT, "lib", "theme.css"), "utf8");
const bubble = fs.readFileSync(path.join(ROOT, "content", "popup.css"), "utf8");

const light = tokens(theme, /\n:root \{([\s\S]*?)\n\}/);
// The dark values are written out twice in each file — a media query and a
// plain selector can't be one rule without a build step. That's only safe if
// the copies stay identical, so assert it here rather than trusting comments.
const darkMedia = tokens(
  theme,
  /prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/
);
const darkAttr = tokens(theme, /\n:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
const dark = Object.assign({}, light, darkMedia);

let failures = audit("LIGHT", light) + audit("DARK", dark) + auditSurfaces("DARK", dark);

function diff(label, a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let n = 0;
  for (const k of keys) {
    if (a[k] !== b[k]) {
      console.log(`  DRIFT ${label} ${k.padEnd(20)} ${a[k]} vs ${b[k]}`);
      n++;
    }
  }
  return n;
}

console.log("\n=== duplicated dark blocks ===");
let drift = diff("theme.css media vs [data-theme=dark]:", darkMedia, darkAttr);

// lib/tour.css carries its own scrim/ring pair, duplicated for the same reason
// (a media query and an attribute selector can't be combined into one rule).
const tourCss = fs.readFileSync(path.join(ROOT, "lib", "tour.css"), "utf8");

function tourVars(re) {
  const m = tourCss.match(re);
  if (!m) throw new Error("tour.css block not found: " + re);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/(--fla-tour-[\w-]+):\s*([^;]+);/g)) out[k] = v.trim();
  return out;
}

drift += diff(
  "tour.css media vs [data-theme=dark]:   ",
  tourVars(
    /prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/
  ),
  tourVars(/\n:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)
);

// content/popup.css keeps its own scoped copy: the bubble sits on a host page,
// where defining custom properties at :root would leak the palette onto it.
const bubbleLight = tokens(bubble, /\n\.fla-bubble \{([\s\S]*?)\n\n/);
const bubbleMedia = tokens(
  bubble,
  /html:not\(\.fla-theme-light\) \.fla-bubble \{([\s\S]*?)\n {2}\}/
);
const bubbleClass = tokens(bubble, /\nhtml\.fla-theme-dark \.fla-bubble \{([\s\S]*?)\n\}/);
drift += diff("bubble media vs .fla-theme-dark:  ", bubbleMedia, bubbleClass);
console.log(drift ? `  ${drift} drifted` : "  in sync");

// The bubble defines a subset of the tokens, so compare only what it declares.
console.log("\n=== content/popup.css copy vs lib/theme.css ===");
let copyDrift = 0;
for (const [scheme, mine, theirs] of [
  ["light", bubbleLight, light],
  ["dark", bubbleMedia, dark],
]) {
  for (const [k, v] of Object.entries(mine)) {
    if (theirs[k] !== v) {
      console.log(`  DRIFT ${scheme.padEnd(6)} ${k.padEnd(20)} bubble=${v} theme=${theirs[k]}`);
      copyDrift++;
    }
  }
}
console.log(copyDrift ? `  ${copyDrift} token(s) drifted` : "  in sync");

failures += drift + copyDrift;
// ---------------------------------------------------------------------------
// Cascade guard.
//
// lib/flip.css is linked BEFORE each page's own stylesheet, and both define
// rules that can match the same element. Equal specificity means the later
// file wins — which silently broke the flip card twice: once by resetting the
// chevron's padding, once by pulling the back face out of absolute positioning
// so it rendered inside the card instead of behind it. Neither showed up in any
// syntax or contrast check, so assert the resolved values here.
// ---------------------------------------------------------------------------

function loadCascade(files) {
  const out = [];
  for (const f of files) {
    const css = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      for (const sel of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
        out.push({ sel, body: m[2] });
      }
    }
  }
  return out;
}

// Enough specificity maths for the selectors this project actually writes.
function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]/g) || []).length;
  return ids * 1000 + cls;
}

function resolveDecl(rules, selectors, prop) {
  let best = null;
  rules.forEach((r, i) => {
    if (!selectors.includes(r.sel)) return;
    const m = r.body.match(new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)"));
    if (!m) return;
    const rank = specificity(r.sel) * 100000 + i;
    if (!best || rank > best.rank) best = { rank, sel: r.sel, value: m[1].trim() };
  });
  return best;
}

// [label, stylesheets in <link> order, [selectors matching one element, prop,
//  expected winner, what breaks if it loses]]
const CASCADE_CHECKS = [
  [
    "side panel card",
    ["lib/theme.css", "lib/tour.css", "lib/flip.css", "sidepanel/sidepanel.css"],
    [
      [[".entry", ".entry--back", ".entry-flip .entry--back"], "position", "absolute",
        "back face falls into normal flow inside the card"],
      [[".entry", ".entry-flip", ".entry-flip .entry--front"], "margin-bottom", "var(--fla-sm)",
        "cards sit flush with no gap between them"],
      [[".entry", ".entry-flip .entry--front"], "padding-right", "34px",
        "the flip chevron overlaps the card's content"]
    ]
  ]
];

console.log("\n=== cascade (equal specificity, later stylesheet wins) ===");
for (const [label, files, checks] of CASCADE_CHECKS) {
  const rules = loadCascade(files);
  for (const [sels, prop, expected, consequence] of checks) {
    const got = resolveDecl(rules, sels, prop);
    const ok = got && got.value === expected;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "ok  " : "FAIL"} ${label}: ${prop} = ${got ? got.value : "(unset)"}` +
        (ok ? ` (from ${got.sel})` : `  -- expected ${expected}; ${consequence}`)
    );
  }
}

console.log(failures ? `\n${failures} problem(s).` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
