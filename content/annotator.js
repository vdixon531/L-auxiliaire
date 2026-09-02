// annotator.js
// Reading aids: gender/plural color-coding, plus a per-page CEFR-ish
// reading-level estimate — both computed from words found on the page, looked
// up against the bundled lexicon via one batched LOOKUP_WORDS message per scan
// pass.
//
// Frequency dimming and cognate underlining were shelved (deliberately, not
// dropped): the toggles, the classes and the CSS are gone, but LOOKUP_WORDS
// still returns freqRank and cognates, and data/cognates.json is still bundled
// — so bringing either back is a UI change, not a data one. Runs alongside
// content-script.js as an independent content script (classic script, not a
// module — content scripts aren't declared as ES modules); talks to it only
// indirectly via the DOM, never shares state.

const WORD_REGEX = /[\p{L}\p{M}'\-]+/gu; // same character class as content-script.js#getWordAtPoint
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION"]);
const SVG_NS = "http://www.w3.org/2000/svg";
const CHUNK_SIZE = 300; // text nodes per idle slice, so a huge page never blocks synchronously
const MUTATION_DEBOUNCE_MS = 500;

// CEFR banding is a frequency-rank heuristic only (v1 deliberately ignores
// known-vocabulary/review history — see CLAUDE.md's message contract note).
const OOV_SENTINEL_RANK = 35000; // no lexicon match counts as "beyond the 30k cutoff", not excluded
const CEFR_SAMPLE_CAP = 20000;
const CEFR_PERCENTILE = 0.65; // upper-mid, not max — one outlier obscure word shouldn't skew the whole page
const CEFR_BANDS = [
  [500, "A1"],
  [1500, "A2"],
  [4000, "B1"],
  [10000, "B2"],
  [20000, "C1"]
]; // else C2

const DEFAULT_COLORS = { masculine: "#4a90d9", feminine: "#d9498a", plural: "#2ea44f", neutral: "#888888" };
// Per-category on/off, separate from the color values above — lets a user
// keep e.g. plural coloring on while turning masculine/feminine off. Mirrors
// popup.js's DEFAULT_CATEGORIES_ENABLED.
const DEFAULT_CATEGORIES_ENABLED = { masculine: true, feminine: true, plural: true, neutral: true };

const wordCache = new Map(); // lowercased word -> {entry, cognate} | null, reused across rescans
const cefrSamples = []; // freqRank per annotated occurrence, capped

let cachedLevel = null; // "A1".."C2" | null until the first scan finishes
let scanInFlight = false;
let observer = null;
let mutationTimer = null;
let cefrTimer = null;

// -----------------------------
// Config — live-reactive across ALL open tabs, not just the active one
// -----------------------------

function applyConfigToDocument(config = {}) {
  const colorCoding = config.colorCoding || {};
  const colors = { ...DEFAULT_COLORS, ...colorCoding };
  const categoriesEnabled = { ...DEFAULT_CATEGORIES_ENABLED, ...(colorCoding.categoriesEnabled || {}) };
  const root = document.documentElement;
  root.style.setProperty("--fla-color-masculine", colors.masculine);
  root.style.setProperty("--fla-color-feminine", colors.feminine);
  root.style.setProperty("--fla-color-plural", colors.plural);
  root.style.setProperty("--fla-color-neutral", colors.neutral);
  root.classList.toggle("fla-colorcoding-on", !!colorCoding.enabled);
  root.classList.toggle("fla-cat-masculine-on", categoriesEnabled.masculine);
  root.classList.toggle("fla-cat-feminine-on", categoriesEnabled.feminine);
  root.classList.toggle("fla-cat-plural-on", categoriesEnabled.plural);
  root.classList.toggle("fla-cat-neutral-on", categoriesEnabled.neutral);

  // Light/dark for the translation bubble. The bubble can't use lib/theme.css
  // (it lives on a host page), so lib/theme-mode.js's data-theme attribute is
  // mirrored here as a class instead — same config.themeMode, same three
  // states, and "system" sets neither class so content/popup.css's
  // prefers-color-scheme query takes back over.
  root.classList.toggle("fla-theme-dark", config.themeMode === "dark");
  root.classList.toggle("fla-theme-light", config.themeMode === "light");
}

chrome.storage.local.get("config").then(({ config }) => applyConfigToDocument(config));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.config) return;
  applyConfigToDocument(changes.config.newValue);
});

// -----------------------------
// DOM walking
// -----------------------------

function isEligibleTextNode(node) {
  if (!node.textContent || !node.textContent.trim()) return false;
  let el = node.parentElement;
  while (el) {
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (el.isContentEditable) return false;
    if (el.namespaceURI === SVG_NS) return false;
    if (el.classList?.contains("fla-bubble") || el.classList?.contains("fla-word")) {
      return false; // our own UI, or a word this pass (or a previous one) already wrapped
    }
    el = el.parentElement;
  }
  return true;
}

function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (isEligibleTextNode(node)) nodes.push(node);
  }
  return nodes;
}

function tokenize(text) {
  return [...text.matchAll(WORD_REGEX)].map((m) => ({ word: m[0], start: m.index, end: m.index + m[0].length }));
}

// -----------------------------
// Scan pipeline: walk -> chunk -> batch-lookup -> wrap
// -----------------------------

async function scan(root) {
  if (scanInFlight) return; // one scan at a time; the mutation debounce coalesces bursts anyway
  scanInFlight = true;
  try {
    const nodes = collectTextNodes(root);
    for (let i = 0; i < nodes.length; i += CHUNK_SIZE) {
      const chunk = nodes.slice(i, i + CHUNK_SIZE);
      await new Promise((resolve) => requestIdleCallback(() => resolve(), { timeout: 200 }));
      await processChunk(chunk);
    }
  } finally {
    scanInFlight = false;
  }
}

async function processChunk(nodes) {
  const matchesByNode = new Map();
  const unknownWords = new Set();

  for (const node of nodes) {
    if (!node.isConnected) continue; // may have been removed since collection
    const matches = tokenize(node.textContent);
    if (!matches.length) continue;
    matchesByNode.set(node, matches);
    for (const { word } of matches) {
      if (!wordCache.has(word.toLowerCase())) unknownWords.add(word);
    }
  }

  if (unknownWords.size > 0) {
    let result = null;
    try {
      result = await chrome.runtime.sendMessage({ type: "LOOKUP_WORDS", words: [...unknownWords] });
    } catch {
      // Extension context gone or message failed — degrade to no annotation
      // for these words rather than throwing on a page we don't own.
    }
    for (const word of unknownWords) {
      const key = word.toLowerCase();
      wordCache.set(key, {
        entry: result?.entries?.[word] || null,
        cognate: null // cognate highlighting is shelved; LOOKUP_WORDS still returns them
      });
    }
  }

  applyToNodes(matchesByNode);
}

// -----------------------------
// Applying results
// -----------------------------

function classesForEntry(entry) {
  const classes = ["fla-word"];
  if (!entry) return classes;
  if (entry.pos === "NOM") {
    if (entry.number === "p") classes.push("fla-word--plural");
    else if (entry.gender === "m") classes.push("fla-word--masculine");
    else if (entry.gender === "f") classes.push("fla-word--feminine");
    else classes.push("fla-word--neutral");
  }
  return classes;
}

function buildWordSpan(word, entry) {
  const span = document.createElement("span");
  span.className = classesForEntry(entry).join(" ");
  span.textContent = word;
  return span;
}

function wrapNode(node, matches) {
  const text = node.textContent;
  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const { word, start, end } of matches) {
    if (start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, start)));
    const cached = wordCache.get(word.toLowerCase());
    const entry = cached?.entry || null;
    frag.appendChild(buildWordSpan(word, entry));
    recordCefrSample(entry);
    cursor = end;
  }
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  node.replaceWith(frag);
}

// Span-wrapping is itself a DOM mutation the observer would otherwise see —
// disconnect/reconnect around it rather than trying to filter mutation
// records, which is simpler and can't drift out of sync.
function applyToNodes(matchesByNode) {
  if (matchesByNode.size === 0) return;
  observer?.disconnect();
  for (const [node, matches] of matchesByNode) {
    if (node.isConnected) wrapNode(node, matches);
  }
  if (observer) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  scheduleCefrRecompute();
}

// -----------------------------
// CEFR reading-level estimate
// -----------------------------

function recordCefrSample(entry) {
  if (cefrSamples.length >= CEFR_SAMPLE_CAP) return;
  // A lexicon hit without a freqRank would push `undefined`, which poisons the
  // numeric sort below and lands every page on C2. Treat it as out-of-vocab,
  // which is what an unranked word effectively is.
  const rank = entry && typeof entry.freqRank === "number" ? entry.freqRank : OOV_SENTINEL_RANK;
  cefrSamples.push(rank);
}

function scheduleCefrRecompute() {
  clearTimeout(cefrTimer);
  cefrTimer = setTimeout(recomputeCefrLevel, 300);
}

function recomputeCefrLevel() {
  if (cefrSamples.length === 0) return;
  const sorted = [...cefrSamples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * CEFR_PERCENTILE));
  const rankAtPercentile = sorted[idx];
  const level = CEFR_BANDS.find(([max]) => rankAtPercentile <= max)?.[1] || "C2";
  if (level === cachedLevel) return;
  cachedLevel = level;
  publishLevel(level);
}

// The readout used to be pull-only (GET_PAGE_LEVEL), and both callers asked
// exactly once — on popup open, and on entering the Settings tab. Scanning is
// chunked across idle callbacks and the recompute above is debounced, so that
// single question almost always arrived before any level existed: the label
// said "Analyzing…" and nothing ever asked again.
//
// Pushing instead fixes both halves — it populates when the answer is ready,
// and it updates when a rescan changes the estimate. The service worker files
// it under this tab's id (which only it knows) for the panel to read.
// GET_PAGE_LEVEL is kept as a fallback; the contract is additive.
function publishLevel(level) {
  chrome.runtime.sendMessage({ type: "PAGE_LEVEL", level }).catch(() => {
    // No receiver (worker asleep, extension reloading) — the next rescan
    // republishes, and the pull path still works.
  });
}

// -----------------------------
// Dynamic content
// -----------------------------

function startObserving() {
  observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => scan(document.body), MUTATION_DEBOUNCE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

// -----------------------------
// Messaging
// -----------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "GET_PAGE_LEVEL") return false;
  sendResponse({ level: cachedLevel, pending: cachedLevel === null && (scanInFlight || cefrSamples.length === 0) });
  return false; // synchronous response, no need to keep the channel open
});

// -----------------------------
// Init
// -----------------------------

(async function init() {
  await scan(document.body);
  startObserving();
})();
