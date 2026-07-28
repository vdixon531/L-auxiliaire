// viewer.js
// Renders a PDF handed off via a token (see lib/pdf-handoff.js) using the
// vendored PDF.js display API (pdf-viewer/vendor/ — see vendor/README.txt for
// exactly what was taken from upstream and why). No build step: pdf.mjs is
// used directly as an ES module, same as any other extension page.
//
// Manual-open only (Phase 4 v1) — this page is reached via chrome.tabs.create
// from popup.js's file picker or "reopen this PDF" button, never via
// automatic PDF-navigation interception (deliberately deferred).

import * as pdfjsLib from "./vendor/pdf.mjs";
import { takeHandoff } from "../lib/pdf-handoff.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf-viewer/vendor/pdf.worker.mjs");

const $ = (id) => document.getElementById(id);

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;
const PRELOAD_MARGIN = "800px 0px"; // render a page slightly before it scrolls into view

let pdfDoc = null;
let scale = 1.25; // a sane default reading zoom, not 1:1 PDF points
let pageNum = 1; // the page most visible in the scroll viewport — for the toolbar only
let renderGeneration = 0; // bumped on zoom change; in-flight renders from the old scale bail out
let pageObserver = null;
let currentPageObserver = null;

// One entry per PDF page: { pageNum, page, viewport, container, rendered,
// rendering, highlightLayer }. Continuous scroll means "the current page" is
// no longer a single global — a selection/click's page is looked up via
// pageEntryForNode() from wherever it actually happened.
const pageEntries = new Map();

// State the interaction/annotation code reads: this document's content-hash
// vocab/cards key. (Per-page viewport lives in pageEntries now, not here —
// continuous scroll means there's no single "current" viewport.)
export const pdfState = {
  pdfUrl: null, // "pdf:<sha256hex>"
  docTitle: ""
};

async function main() {
  const token = new URLSearchParams(location.search).get("handoff");
  if (!token) {
    showError("No PDF was handed off to this viewer — open one from the popup's file picker.");
    return;
  }

  const handoff = await takeHandoff(token);
  if (!handoff) {
    showError("This PDF link has expired. Try opening it again from the popup.");
    return;
  }

  pdfState.docTitle = handoff.filename || "PDF document";
  $("docTitle").textContent = pdfState.docTitle;
  document.title = `${pdfState.docTitle} — L'auxiliaire`;

  pdfState.pdfUrl = await hashToPdfUrl(handoff.arrayBuffer);

  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(handoff.arrayBuffer),
      cMapUrl: chrome.runtime.getURL("pdf-viewer/vendor/cmaps/"),
      cMapPacked: true
    });
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    console.error("[FLA pdf-viewer]", err);
    showError("Couldn't open this file — it may not be a valid PDF.");
    return;
  }

  $("pageCount").textContent = pdfDoc.numPages;
  $("pageNum").max = pdfDoc.numPages;
  await layoutAllPages();
  observePages();
}

async function hashToPdfUrl(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pdf:${hex}`;
}

// -----------------------------
// Continuous-scroll rendering: every page gets a correctly-sized placeholder
// up front (so the scrollbar/scroll position reflects the true document
// length immediately), and each page's canvas/text-layer/highlights are only
// actually rendered once it scrolls near the viewport (IntersectionObserver,
// below) — rendering all pages of a long PDF eagerly would be slow and
// memory-heavy. Known v1 limitation: rendered pages are never torn back down
// as they scroll far away, so a very large document (hundreds of pages) will
// still accumulate memory over a long scroll session — acceptable for the
// realistic case (articles/chapters/short books), not attempting Mozilla's
// full page-recycling virtualization here.
// -----------------------------

async function layoutAllPages() {
  const container = $("viewerContainer");
  container.innerHTML = "";
  pageEntries.clear();

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const viewport = page.getViewport({ scale });

    const div = document.createElement("div");
    div.className = "page";
    div.dataset.pageNum = n;
    div.style.width = `${viewport.width}px`;
    div.style.height = `${viewport.height}px`;
    container.appendChild(div);

    pageEntries.set(n, { pageNum: n, page, viewport, container: div, rendered: false, rendering: false });
  }
}

async function ensurePageRendered(n) {
  const entry = pageEntries.get(n);
  if (!entry || entry.rendered || entry.rendering) return;
  entry.rendering = true;
  const myGeneration = renderGeneration;

  const canvas = document.createElement("canvas");
  canvas.width = entry.viewport.width;
  canvas.height = entry.viewport.height;
  entry.container.appendChild(canvas);
  await entry.page.render({ canvasContext: canvas.getContext("2d"), viewport: entry.viewport }).promise;
  if (myGeneration !== renderGeneration) return; // zoom changed mid-render; layoutAllPages already tore this down

  const highlightLayer = document.createElement("div");
  highlightLayer.className = "fla-pdf-highlights";
  entry.container.appendChild(highlightLayer);

  const textLayerDiv = document.createElement("div");
  textLayerDiv.className = "textLayer";
  entry.container.appendChild(textLayerDiv);
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: entry.page.streamTextContent(),
    container: textLayerDiv,
    viewport: entry.viewport
  });
  await textLayer.render();
  if (myGeneration !== renderGeneration) return;

  entry.highlightLayer = highlightLayer;
  entry.rendered = true;
  entry.rendering = false;

  await drawStoredHighlights(entry.viewport, highlightLayer, n);
}

function observePages() {
  pageObserver?.disconnect();
  currentPageObserver?.disconnect();

  const root = $("viewerContainer");

  // Wide margin: renders a page slightly before it's actually visible.
  pageObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) ensurePageRendered(parseInt(e.target.dataset.pageNum, 10));
      }
    },
    { root, rootMargin: PRELOAD_MARGIN, threshold: 0.01 }
  );

  // Separate, tighter observer just to track which page is "current" for the
  // toolbar's page-number display — most-visible page wins.
  currentPageObserver = new IntersectionObserver(
    (entries) => {
      let best = null;
      for (const e of entries) {
        if (e.isIntersecting && (!best || e.intersectionRatio > best.intersectionRatio)) best = e;
      }
      if (best) {
        pageNum = parseInt(best.target.dataset.pageNum, 10);
        // Don't clobber the page-number input while the user is typing in it.
        if (document.activeElement !== $("pageNum")) $("pageNum").value = pageNum;
        updateNavButtons();
      }
    },
    { root, threshold: [0.25, 0.5, 0.75] }
  );

  for (const entry of pageEntries.values()) {
    pageObserver.observe(entry.container);
    currentPageObserver.observe(entry.container);
  }
}

// Given a node from inside a rendered page's text layer, finds which page it
// belongs to — needed because a selection/click's page is no longer
// implied by "the current page" once every page can be on screen/rendered.
function pageEntryForNode(node) {
  const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  const pageDiv = el?.closest?.(".page");
  if (!pageDiv) return null;
  return pageEntries.get(parseInt(pageDiv.dataset.pageNum, 10)) || null;
}

function updateNavButtons() {
  $("prevPage").disabled = pageNum <= 1;
  $("nextPage").disabled = !pdfDoc || pageNum >= pdfDoc.numPages;
}

function showError(msg) {
  $("viewerContainer").innerHTML = `<div class="fla-error"></div>`;
  $("viewerContainer").firstChild.textContent = msg;
}

function scrollToPage(n) {
  pageEntries.get(n)?.container.scrollIntoView({ block: "start", behavior: "instant" });
}

async function setScale(next) {
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  $("zoomLevel").textContent = `${Math.round(scale * 100)}%`;
  renderGeneration++; // invalidates any render still in flight at the old scale
  const anchorPage = pageNum;
  await layoutAllPages();
  observePages();
  scrollToPage(anchorPage); // land back roughly where the user was
}

$("prevPage").addEventListener("click", () => scrollToPage(Math.max(1, pageNum - 1)));
$("nextPage").addEventListener("click", () => scrollToPage(Math.min(pdfDoc?.numPages || 1, pageNum + 1)));
$("pageNum").addEventListener("change", (e) => {
  const n = Math.min(pdfDoc?.numPages || 1, Math.max(1, parseInt(e.target.value, 10) || 1));
  scrollToPage(n);
});
$("zoomIn").addEventListener("click", () => setScale(scale + SCALE_STEP));
$("zoomOut").addEventListener("click", () => setScale(scale - SCALE_STEP));

// -----------------------------
// Translate/save/conjugate interaction — ported from content/content-script.js
// (not imported: that file is a classic script for <all_urls> content-script
// injection, a different mechanism entirely from this ES-module extension
// page; see the Phase 4 plan for why sharing isn't practical here). Behavior
// is intentionally identical: click-to-translate is always on, hover-dwell
// is optional/additive, selection always translates the whole selection —
// same rationale as the web-page version.
// -----------------------------

const BUBBLE_ID = "fla-bubble";
const HOVER_DEBOUNCE_MS = 400;

let hoverModeEnabled = false;
let currentBubble = null;
let hoverTimer = null;
let isMouseDown = false;

// Our own toolbar controls (button/input) are already covered by this
// selector, so clicking "Next page" etc. won't also trigger translate-on-click.
const INTERACTIVE_SELECTOR = "a, button, input, textarea, select, label, [role='button'], [contenteditable], [contenteditable='true']";

function isInteractiveTarget(el) {
  return !!(el && el.closest && el.closest(INTERACTIVE_SELECTOR));
}

function removeBubble() {
  if (currentBubble) {
    currentBubble.remove();
    currentBubble = null;
  }
}

function createBubble(x, y) {
  removeBubble();
  const bubble = document.createElement("div");
  bubble.id = BUBBLE_ID;
  bubble.className = "fla-bubble";
  bubble.style.left = `${x}px`;
  bubble.style.top = `${y}px`;
  bubble.innerHTML = `<div class="fla-loading">Translating…</div>`;
  document.body.appendChild(bubble);
  currentBubble = bubble;
  return bubble;
}

// `sourceRange` (the Range the word/selection was translated from) is PDF-
// viewer-only, threaded through so the Highlight button can convert it to
// PDF-space coordinates and persist it — content-script.js's version of this
// function has no equivalent parameter, since regular web pages don't have
// an overlay-annotation feature.
function renderBubble(bubble, { source, translation, sourceLang, targetLang }, contextSentence, sourceRange) {
  bubble.innerHTML = `
    <div class="fla-row">
      <span class="fla-lang">${sourceLang}</span>
      <span class="fla-text">${escapeHtml(source)}</span>
      <button class="fla-btn" data-action="speak-source" title="Play">▶</button>
    </div>
    <div class="fla-row fla-translation">
      <span class="fla-lang">${targetLang}</span>
      <span class="fla-text">${escapeHtml(translation)}</span>
      <button class="fla-btn" data-action="speak-target" title="Play">▶</button>
    </div>
    <div class="fla-actions">
      <button class="fla-btn fla-save" data-action="save">＋ Save</button>
      <button class="fla-btn fla-conj" data-action="conjugate">Conjugate</button>
      <button class="fla-btn fla-workbook" data-action="workbook" title="Open workbook">📖 Workbook</button>
      <button class="fla-btn fla-highlight" data-action="highlight" title="Highlight in the PDF">🖍 Highlight</button>
    </div>
  `;

  bubble.querySelector('[data-action="speak-source"]').onclick = () => speak(source, sourceLang);
  bubble.querySelector('[data-action="speak-target"]').onclick = () => speak(translation, targetLang);
  bubble.querySelector('[data-action="save"]').onclick = () =>
    saveWord({ source, translation, sourceLang, targetLang, contextSentence });
  bubble.querySelector('[data-action="conjugate"]').onclick = () =>
    requestConjugation(sourceLang === "fr" ? source : translation);
  bubble.querySelector('[data-action="workbook"]').onclick = () =>
    chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL", view: "vocab" });
  bubble.querySelector('[data-action="highlight"]').onclick = () => saveHighlight(sourceRange);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function speak(text, langCode) {
  const lang = langCode === "fr" ? "fr-FR" : "en-US";
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  utter.rate = 0.9;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

// PDF.js's text layer has no P/DIV paragraph structure — each line is a
// <span> directly inside the page's .textLayer div, and .textLayer itself IS
// a DIV, so this walk stops there, treating the whole page as one sentence-
// extraction container (BOUNDARY-based trimming below still finds a
// reasonable local sentence within it). Coarser than the web-page version's
// per-paragraph granularity, but a reasonable v1 tradeoff — PDF text runs
// don't reliably map to real paragraph boundaries anyway.
const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6",
  "ARTICLE", "SECTION", "BLOCKQUOTE", "FIGCAPTION", "PRE"
]);

function findBlockAncestor(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return (node.nodeType === Node.TEXT_NODE ? node.parentElement : node) || document.body;
}

function rangeOffsetsInContainer(range, container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let offset = 0;
  let start = null;
  let end = null;
  let node;
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) start = offset + range.startOffset;
    if (node === range.endContainer) end = offset + range.endOffset;
    offset += node.textContent.length;
  }
  return { start, end };
}

function getContextSentence(range) {
  if (!range) return "";
  const container = findBlockAncestor(range.commonAncestorContainer);
  const text = container.textContent || "";
  const { start, end } = rangeOffsetsInContainer(range, container);
  if (start == null || end == null) return text.trim().slice(0, 300);

  const BOUNDARY = /[.!?\n]/;
  let sentStart = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (BOUNDARY.test(text[i])) {
      sentStart = i + 1;
      break;
    }
  }
  let sentEnd = text.length;
  for (let i = end; i < text.length; i++) {
    if (BOUNDARY.test(text[i])) {
      sentEnd = i + 1;
      break;
    }
  }
  return text.slice(sentStart, sentEnd).trim();
}

function getSelectionText() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  return { text, rect, range };
}

function hasActiveSelection() {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
}

document.addEventListener("mousedown", () => {
  isMouseDown = true;
});

document.addEventListener("mouseup", async (e) => {
  isMouseDown = false;
  if (currentBubble && currentBubble.contains(e.target)) return;

  const sel = getSelectionText();
  if (sel) {
    const contextSentence = getContextSentence(sel.range);
    const x = window.scrollX + sel.rect.left;
    const y = window.scrollY + sel.rect.bottom + 8;
    const bubble = createBubble(x, y);
    await requestTranslation(sel.text, bubble, contextSentence, sel.range);
    return;
  }

  removeBubble();
  if (isInteractiveTarget(e.target)) return;

  const word = getWordAtPoint(e.clientX, e.clientY);
  if (!word || !word.text) return;

  const contextSentence = getContextSentence(word.range);
  const x = window.scrollX + word.rect.left;
  const y = window.scrollY + word.rect.bottom + 8;
  const bubble = createBubble(x, y);
  await requestTranslation(word.text, bubble, contextSentence, word.range);
});

document.addEventListener("mousemove", (e) => {
  if (!hoverModeEnabled) return;
  clearTimeout(hoverTimer);
  if (isMouseDown) return;
  if (hasActiveSelection()) return;

  hoverTimer = setTimeout(async () => {
    if (isMouseDown) return;
    if (hasActiveSelection()) return;
    if (isInteractiveTarget(e.target)) return;
    const word = getWordAtPoint(e.clientX, e.clientY);
    if (!word || !word.text) return;

    const contextSentence = getContextSentence(word.range);
    const x = window.scrollX + word.rect.left;
    const y = window.scrollY + word.rect.bottom + 8;
    const bubble = createBubble(x, y);
    await requestTranslation(word.text, bubble, contextSentence, word.range);
  }, HOVER_DEBOUNCE_MS);
});

function getWordAtPoint(x, y) {
  const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  if (!range) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent;
  const offset = range.startOffset;

  const wordRegex = /[\p{L}\p{M}'\-]/u;
  let start = offset;
  let end = offset;
  while (start > 0 && wordRegex.test(text[start - 1])) start--;
  while (end < text.length && wordRegex.test(text[end])) end++;
  const wordText = text.slice(start, end).trim();
  if (!wordText) return null;

  const wordRange = document.createRange();
  wordRange.setStart(node, start);
  wordRange.setEnd(node, end);

  const rects = wordRange.getClientRects();
  const inside = [...rects].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  if (!inside) return null;

  return { text: wordText, rect: wordRange.getBoundingClientRect(), range: wordRange };
}

async function requestTranslation(text, bubble, contextSentence, sourceRange) {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "TRANSLATE", text, contextSentence });
    if (resp?.error) {
      bubble.innerHTML = `<div class="fla-error">${escapeHtml(resp.error)}</div>`;
      return null;
    }
    renderBubble(bubble, resp, contextSentence, sourceRange);
    return resp;
  } catch (err) {
    bubble.innerHTML = `<div class="fla-error">Translation failed</div>`;
    console.error("[FLA pdf-viewer]", err);
    return null;
  }
}

// Stamps the content-hash key + a human-readable title onto every save, so
// this PDF's words land in vocab["pdf:<hash>"]/cards regardless of which tab
// URL happens to be showing (viewer.html?handoff=...) — service-worker.js's
// SAVE_WORD handler respects an explicit entry.url instead of overwriting it
// with sender.tab.url specifically so this works.
async function saveWord(entry) {
  try {
    await chrome.runtime.sendMessage({
      type: "SAVE_WORD",
      entry: { ...entry, url: pdfState.pdfUrl, pdfTitle: pdfState.docTitle }
    });
    flashBubbleFeedback("Saved ✓");
  } catch (err) {
    console.error("[FLA pdf-viewer] save failed", err);
  }
}

// -----------------------------
// Overlay annotations (persist across sessions) — the smallest of the three
// Phase 4 pieces, deliberately thin: capture-on-highlight, redraw-on-render,
// no rich annotation types. Storage key is the content hash WITHOUT the
// "pdf:" prefix (this bucket is PDF-only by construction, so the prefix
// would be redundant) — separate from vocab/cards, since a highlight isn't
// necessarily a saved vocab word and vice versa.
// -----------------------------

function pdfContentHash() {
  return pdfState.pdfUrl?.startsWith("pdf:") ? pdfState.pdfUrl.slice(4) : null;
}

// PDF.js's text layer frequently emits one <span> per text RUN, not one per
// visual LINE — a single selected line can therefore produce several
// slightly-mismatched client rects (tiny top/height differences from
// per-span font-metric rounding) instead of one clean rectangle, which is
// what made highlights look fragmented/jittery rather than a solid bar.
// Merge rects that vertically overlap by more than half of either one's
// height into a single bounding rect per line before storing/drawing.
function mergeLineRects(domRects) {
  const rects = [...domRects].filter((r) => r.width > 0 && r.height > 0);
  const lines = [];
  for (const r of [...rects].sort((a, b) => a.top - b.top)) {
    const line = lines.find(
      (l) => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > 0.5 * Math.min(l.bottom - l.top, r.bottom - r.top)
    );
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.top = Math.min(line.top, r.top);
      line.right = Math.max(line.right, r.right);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }
  return lines;
}

// Stores rects in PDF USER-SPACE points (scale=1), not CSS pixels — that's
// what survives zoom/resize, since it's real PDF geometry rather than screen
// coordinates tied to whatever scale happened to be active when it was drawn.
async function saveHighlight(range) {
  if (!range) return;
  const hash = pdfContentHash();
  if (!hash) return;

  // Continuous scroll means the selection could be on any rendered page, not
  // "the current one" — find its actual page rather than assuming.
  const entry = pageEntryForNode(range.commonAncestorContainer);
  if (!entry) return;

  const pageBox = entry.container.getBoundingClientRect();
  const viewport = entry.viewport;
  const rects = mergeLineRects(range.getClientRects()).map((r) => {
    const [x1, y1] = viewport.convertToPdfPoint(r.left - pageBox.left, r.top - pageBox.top);
    const [x2, y2] = viewport.convertToPdfPoint(r.right - pageBox.left, r.bottom - pageBox.top);
    return { x1, y1, x2, y2 };
  });
  if (rects.length === 0) return;

  const record = { id: crypto.randomUUID(), page: entry.pageNum, rects, createdAt: Date.now() };

  const { pdfAnnotations = {} } = await chrome.storage.local.get("pdfAnnotations");
  const list = pdfAnnotations[hash] || [];
  list.push(record);
  pdfAnnotations[hash] = list;
  await chrome.storage.local.set({ pdfAnnotations });

  if (entry.highlightLayer) drawHighlight(record, viewport, entry.highlightLayer);
  flashBubbleFeedback("Highlighted ✓");
}

function drawHighlight(record, viewport, layer) {
  for (const { x1, y1, x2, y2 } of record.rects) {
    const [vx1, vy1] = viewport.convertToViewportPoint(x1, y1);
    const [vx2, vy2] = viewport.convertToViewportPoint(x2, y2);
    const div = document.createElement("div");
    div.className = "fla-pdf-highlight";
    div.style.left = `${Math.min(vx1, vx2)}px`;
    div.style.top = `${Math.min(vy1, vy2)}px`;
    div.style.width = `${Math.abs(vx2 - vx1)}px`;
    div.style.height = `${Math.abs(vy2 - vy1)}px`;
    layer.appendChild(div);
  }
}

async function drawStoredHighlights(viewport, layer, page) {
  const hash = pdfContentHash();
  if (!hash) return;
  const { pdfAnnotations = {} } = await chrome.storage.local.get("pdfAnnotations");
  const list = (pdfAnnotations[hash] || []).filter((a) => a.page === page);
  for (const record of list) drawHighlight(record, viewport, layer);
}

async function handleSaveSelectionShortcut() {
  const sel = getSelectionText();
  if (!sel) return;

  const contextSentence = getContextSentence(sel.range);
  const x = window.scrollX + sel.rect.left;
  const y = window.scrollY + sel.rect.bottom + 8;
  const bubble = createBubble(x, y);
  const resp = await requestTranslation(sel.text, bubble, contextSentence);
  if (resp) {
    await saveWord({
      source: resp.source,
      translation: resp.translation,
      sourceLang: resp.sourceLang,
      targetLang: resp.targetLang,
      contextSentence
    });
  }
}

async function requestConjugation(verb) {
  const resp = await chrome.runtime.sendMessage({ type: "CONJUGATE", verb });
  if (resp?.error) {
    flashBubbleFeedback(resp.error);
    return;
  }
  await chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL", view: "conjugation", verb });
}

function flashBubbleFeedback(msg) {
  if (!currentBubble) return;
  const flash = document.createElement("div");
  flash.className = "fla-flash";
  flash.textContent = msg;
  currentBubble.appendChild(flash);
  setTimeout(() => flash.remove(), 1500);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SET_HOVER_MODE") {
    hoverModeEnabled = !!msg.enabled;
    if (!hoverModeEnabled) removeBubble();
    sendResponse({ ok: true });
  }
  if (msg.type === "TRANSLATE_STATUS") {
    if (currentBubble && msg.status === "downloading") {
      currentBubble.innerHTML = `<div class="fla-loading">Downloading language pack (one-time)…</div>`;
    }
  }
  if (msg.type === "READ_SELECTION") {
    const sel = getSelectionText();
    if (sel) speak(sel.text, msg.lang || "fr");
    sendResponse({ ok: !!sel });
  }
  if (msg.type === "SAVE_SELECTION") {
    handleSaveSelectionShortcut();
    sendResponse({ ok: true });
  }
});

// Initial state, plus live cross-tab reactivity (this tab might not be
// active when the user toggles hover mode from the popup/Alt+T — annotator.js
// established this chrome.storage.onChanged pattern in Phase 2 for exactly
// this kind of per-tab setting that shouldn't require the tab to be focused).
chrome.storage.local.get("config").then(({ config = {} }) => {
  hoverModeEnabled = !!config.hoverModeEnabled;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.config) {
    hoverModeEnabled = !!changes.config.newValue?.hoverModeEnabled;
  }
});

main();
