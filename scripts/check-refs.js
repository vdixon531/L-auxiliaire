/**
 * Undefined-reference guard. Run: node scripts/check-refs.js
 *
 * Reports any function called in our own JS that isn't declared in that file,
 * imported by it, or a known global.
 *
 * This exists because `node --check` only proves a file *parses* — it says
 * nothing about whether what it calls exists. A text edit that replaced a range
 * of sidepanel.js silently swallowed two function declarations that happened to
 * sit inside that range. Every other check in this repo passed; the failure
 * surfaced only at runtime, as a ReferenceError with the word list blank.
 *
 * Two deliberate biases keep false positives near zero:
 *  - bindings are OVER-collected, so a real local is never reported;
 *  - calls are UNDER-collected (`name(` only, never `.name(`).
 * A deleted function still trips it: its name stops appearing in any binding
 * position while its call sites remain.
 *
 * The source is stripped LINE BY LINE. A single-pass character scanner desyncs
 * catastrophically — one mis-read quote inverts every string boundary after it,
 * which turned half of sidepanel.js into "code" on the first attempt. Strings
 * and line comments can't span a newline in JS, so scanning per line bounds any
 * mistake to that one line. Only block comments and template literals carry
 * state across lines.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const FILES = [
  "background/service-worker.js",
  "background/offscreen.js",
  "background/cache.js",
  "background/conjugation.js",
  "background/lexicon.js",
  "background/srs.js",
  "background/detect-lang.js",
  "content/content-script.js",
  "content/annotator.js",
  "lib/settings-panel.js",
  "lib/practice-panel.js",
  "lib/theme-mode.js",
  "lib/tour.js",
  "lib/flip.js",
  "lib/fuzzy-match.js",
  "lib/normalize-url.js",
  "lib/pdf-handoff.js",
  "pdf-viewer/bridge.js",
  "popup/popup.js",
  "sidepanel/sidepanel.js",
  "welcome/welcome.js",
  "permission/grant-mic.js"
];

// Keywords that read as `name(`, plus lowercase platform globals.
// Capitalised identifiers are skipped wholesale by the call regex.
const GLOBALS = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "typeof", "await",
  "async", "new", "do", "else", "try", "finally", "of", "in", "delete", "void",
  "yield", "case", "instanceof",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "structuredClone", "require",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
  "fetch", "alert", "confirm", "prompt", "atob", "btoa", "importScripts",
  "getComputedStyle", "matchMedia", "postMessage", "close", "open", "focus", "blur",
  "escape", "unescape", "chrome", "console", "document", "window", "globalThis",
  "self", "indexedDB", "crypto", "speechSynthesis", "navigator", "location"
]);

const REGEX_PRECEDER = /[(,=:[!&|?{};+\-*%<>~^]$/;

function strip(src) {
  const out = [];
  let inBlockComment = false;
  let inTemplate = false;

  for (const line of src.split("\n")) {
    let result = "";
    let i = 0;

    while (i < line.length) {
      if (inBlockComment) {
        const end = line.indexOf("*/", i);
        if (end === -1) { i = line.length; break; }
        inBlockComment = false;
        i = end + 2;
        result += " ";
        continue;
      }

      if (inTemplate) {
        // Template text is blanked, but ${...} interiors survive — they hold
        // real calls, e.g. `${escapeAttr(entry.source)}`.
        if (line[i] === "\\") { i += 2; continue; }
        if (line[i] === "`") { inTemplate = false; i++; result += ' "" '; continue; }
        if (line[i] === "$" && line[i + 1] === "{") {
          i += 2;
          let depth = 1;
          const start = i;
          while (i < line.length && depth > 0) {
            if (line[i] === "{") depth++;
            else if (line[i] === "}") depth--;
            if (depth > 0) i++;
          }
          result += " " + strip(line.slice(start, i)) + " ";
          i++;
          continue;
        }
        i++;
        continue;
      }

      const c = line[i];
      const next = line[i + 1];

      if (c === "/" && next === "*") { inBlockComment = true; i += 2; continue; }
      if (c === "/" && next === "/") break; // rest of the line is a comment
      if (c === "`") { inTemplate = true; i++; continue; }

      if (c === "'" || c === '"') {
        i++;
        while (i < line.length && line[i] !== c) i += line[i] === "\\" ? 2 : 1;
        i++; // an unterminated quote just ends at EOL — damage stays on this line
        result += ' "" ';
        continue;
      }

      // A regex can also open a line — an array of patterns, one per line, has
      // no preceding token to test against.
      const before = result.trimEnd();
      if (c === "/" && (before === "" || REGEX_PRECEDER.test(before))) {
        i++;
        let inClass = false;
        while (i < line.length) {
          if (line[i] === "\\") { i += 2; continue; }
          if (line[i] === "[") inClass = true;
          else if (line[i] === "]") inClass = false;
          else if (line[i] === "/" && !inClass) { i++; break; }
          i++;
        }
        while (i < line.length && /[a-z]/.test(line[i])) i++; // flags
        result += " 0 ";
        continue;
      }

      result += c;
      i++;
    }

    out.push(result);
  }

  return out.join("\n");
}

function bindings(src) {
  const out = new Set();
  const add = (re) => {
    for (const m of src.matchAll(re)) if (m[1]) out.add(m[1]);
  };

  add(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g);
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  add(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g);
  add(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/gm);

  // Destructuring, import lists and parameter lists: take every identifier
  // inside. Over-collecting is the safe direction here.
  for (const m of src.matchAll(/(?:const|let|var|import)\s*[{[]([^}\]]*)[}\]]/g)) {
    for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) out.add(n[1]);
  }
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) out.add(n[1]);
  }
  // Object-literal methods and shorthand: `name(a) {` / `name: function`.
  add(/\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g);
  // Class methods. Their DECLARATION (`render() {`) is indistinguishable from a
  // call site to the scan below, so they must be collected as bindings — every
  // actual call to them goes through `this.` and is ignored anyway.
  add(/^\s*(?:static\s+)?(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm);

  return out;
}

let problems = 0;
for (const rel of FILES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    console.log(`  ??   ${rel} — listed but missing from disk`);
    problems++;
    continue;
  }

  const src = strip(fs.readFileSync(full, "utf8"));
  const declared = bindings(src);

  const called = new Set();
  for (const m of src.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/g)) called.add(m[1]);

  const missing = [...called].filter((n) => !declared.has(n) && !GLOBALS.has(n)).sort();
  if (missing.length) {
    console.log(`  FAIL ${rel}`);
    for (const n of missing) {
      console.log(`         ${n}() is called but never defined or imported`);
    }
    problems += missing.length;
  }
}

console.log(problems ? `\n${problems} undefined reference(s).` : "No undefined references.");
process.exit(problems ? 1 : 0);
