// bridge.js
// Bridges this extension's translate/save/conjugate/workbook features into
// Mozilla's own prebuilt PDF.js viewer (pdf-viewer/vendor/web/viewer.mjs).
//
// Earlier versions of this file drove a hand-rolled render pipeline (single
// page, then continuous-scroll) and a custom highlight-overlay annotation
// feature — both had real bugs (layout jankiness, misaligned highlights) that
// came from re-implementing things PDF.js's own reference viewer already
// does correctly: continuous scroll with proper virtualization, zoom, and a
// pixel-correct native highlight annotation tool. Switched to using that
// viewer directly rather than continuing to debug a hand-rolled one; this
// file now only adds our own features on top via the DOM/its event bus,
// nothing about rendering pages.

import { takeHandoff } from "../lib/pdf-handoff.js";

// Must run before PDFViewerApplication.run() reads defaultUrl — "webviewerloaded"
// fires synchronously right before run() is called (see vendor/web/viewer.mjs's
// webViewerLoad()). Without this, the stock build falls back to opening its
// bundled sample PDF (compressed.tracemonkey-pldi-09.pdf) when no ?file= is
// present, which we deliberately didn't vendor — we always load via the
// handoff token instead (see loadHandoff() below).
document.addEventListener("webviewerloaded", () => {
  window.PDFViewerApplicationOptions.set("defaultUrl", "");
});

const pdfState = {
  pdfUrl: null, // "pdf:<sha256hex>" — the vocab/cards key for this document
  docTitle: ""
};

async function hashToPdfUrl(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pdf:${hex}`;
}

async function loadHandoff() {
  const token = new URLSearchParams(location.search).get("handoff");
  if (!token) return; // opened with no handoff — PDF.js's own "Open File" toolbar button still works

  const handoff = await takeHandoff(token);
  if (!handoff) {
    console.error("[FLA pdf-viewer] handoff missing or expired:", token);
    return;
  }

  pdfState.docTitle = handoff.filename || "PDF document";
  pdfState.pdfUrl = await hashToPdfUrl(handoff.arrayBuffer);
  document.title = `${pdfState.docTitle} — L'auxiliaire`;

  await window.PDFViewerApplication.initializedPromise;
  await window.PDFViewerApplication.open({
    data: new Uint8Array(handoff.arrayBuffer),
    filename: pdfState.docTitle
  });
}

loadHandoff();

// -----------------------------
// Translate/save/conjugate interaction — ported from content/content-script.js
// (not imported: that file is a classic script for <all_urls> content-script
// injection, a different mechanism from this ES-module extension page).
// Attaches at the document level, so it works against whatever PDF.js's own
// viewer renders (its text-layer spans are the same underlying technique
// content-script.js already handles) without needing to know anything about
// the viewer's internal page/scroll/zoom machinery. Behavior is identical to
// the web-page version: click-to-translate is always on, hover-dwell is
// optional/additive, selection always translates the whole selection.
// -----------------------------

const BUBBLE_ID = "fla-bubble";
const HOVER_DEBOUNCE_MS = 400;

let hoverModeEnabled = false;
let currentBubble = null;
let hoverTimer = null;
let isMouseDown = false;

// PDF.js's own toolbar is full of buttons/inputs — already covered by this
// selector, so clicking any of its controls won't also trigger translate-on-click.
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

function renderBubble(bubble, { source, translation, sourceLang, targetLang }, contextSentence) {
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
// <span> directly inside a page's .textLayer div, and .textLayer itself IS a
// DIV, so this walk stops there, treating the whole page as one sentence-
// extraction container (BOUNDARY-based trimming below still finds a
// reasonable local sentence within it). Coarser than the web-page version's
// per-paragraph granularity, but a reasonable tradeoff — PDF text runs don't
// reliably map to real paragraph boundaries anyway.
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
    await requestTranslation(sel.text, bubble, contextSentence);
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
  await requestTranslation(word.text, bubble, contextSentence);
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
    await requestTranslation(word.text, bubble, contextSentence);
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

  // caretRangeFromPoint snaps to the NEAREST caret position even when (x, y)
  // isn't actually over any text — reject unless the point truly falls
  // inside the resolved word's own rect(s).
  const rects = wordRange.getClientRects();
  const inside = [...rects].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  if (!inside) return null;

  return { text: wordText, rect: wordRange.getBoundingClientRect(), range: wordRange };
}

async function requestTranslation(text, bubble, contextSentence) {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "TRANSLATE", text, contextSentence });
    if (resp?.error) {
      bubble.innerHTML = `<div class="fla-error">${escapeHtml(resp.error)}</div>`;
      return null;
    }
    renderBubble(bubble, resp, contextSentence);
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
