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

// Stops the stock viewer opening its bundled sample PDF
// (compressed.tracemonkey-pldi-09.pdf), which this project deliberately didn't
// vendor, so the request 404s. We always load via the handoff token instead.
//
// THE PRIMARY DEFENCE IS NOT HERE — it's the empty `file=` that popup.js puts
// in the viewer URL. viewer.mjs does:
//
//     file = params.get("file") ?? AppOptions.get("defaultUrl");
//
// and `??` only falls through on null/undefined, so an empty-string `file`
// means defaultUrl is never consulted at all. `file` then fails the falsy
// guards in validateFileURL() and `if (file)`, so nothing is opened and no
// request is made. That has no timing dependency whatsoever.
//
// Setting the option here is a fallback for a tab opened with an older URL
// that has no file= param. It is NOT reliable on its own: viewer.mjs ends with
//
//     if (document.readyState === "interactive" || … === "complete") webViewerLoad();
//
// and per the HTML spec's "the end" readyState becomes "interactive" *before*
// deferred/module scripts run — so viewer.mjs calls webViewerLoad() (which
// dispatches webviewerloaded, then calls run()) during its own evaluation, and
// this file, whose <script> comes after it, is too late for the event. run() is
// async, but whether it reaches the defaultUrl read before or after this module
// executes depends on how many real async boundaries initialize() crosses —
// which is a race, and one this file lost in practice.
function suppressStockDefaultPdf() {
  window.PDFViewerApplicationOptions?.set("defaultUrl", "");
}

suppressStockDefaultPdf();
document.addEventListener("webviewerloaded", suppressStockDefaultPdf);

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
    // Expected whenever the tab outlives its staged bytes: the record is swept
    // after 30 minutes (PDF_HANDOFF_MAX_AGE_MS in service-worker.js), and
    // reloading the extension re-navigates any open viewer tab to this same
    // ?handoff= URL long after that. Until now this only wrote to the console
    // and left an empty viewer, which reads as "the extension is broken".
    console.error("[FLA pdf-viewer] handoff missing or expired:", token);
    showViewerError(
      "This PDF is no longer loaded",
      "Its contents are staged only for a short while after you open it, and that " +
        "window has passed — reloading the extension or coming back to an old tab " +
        "will both land you here. Open the file again from the extension popup, or " +
        "use this viewer's own Open File button."
    );
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

// Styled by content/popup.css (already linked into viewer.html for the bubble),
// so it picks up the same palette and light/dark handling. Built with the DOM
// rather than innerHTML+inline styles because the vendored viewer.html carries
// its own strict CSP (`style-src 'self'`) — CSSOM and classes are fine there,
// a style attribute would not be.
function showViewerError(title, detail) {
  document.getElementById("fla-viewer-error")?.remove();
  const box = document.createElement("div");
  box.id = "fla-viewer-error";
  box.className = "fla-viewer-error";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = detail;
  box.append(h, p);
  document.body.appendChild(box);
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
const HOVER_DEBOUNCE_MS = 900;
const BUBBLE_MARGIN = 8;
const DEFER_TRANSLATE_SEGMENTS = 4;
// Ceiling on a saved context sentence. Unpunctuated text (a heading, a table
// cell, a PDF page whose sentence boundaries didn't survive extraction) has no
// natural end, and the whole container is not "a sentence".
const MAX_CONTEXT_CHARS = 400;

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

function removeBubble({ immediate = false } = {}) {
  const bubble = currentBubble;
  currentBubble = null;
  if (!bubble) return;

  // Whatever the bubble was reading belongs to the bubble. Leaving a voice
  // talking after the thing that started it is gone is disorienting, and on a
  // long passage it can run for a while.
  window.speechSynthesis?.cancel();

  if (immediate) {
    // Being replaced by another bubble — a fade here would leave two on screen.
    bubble.remove();
    return;
  }
  bubble.classList.add("fla-bubble--out");
  setTimeout(() => bubble.remove(), 160);
}

// Scrolling moves the page out from under the bubble, which was anchored to a
// word that may now be off screen. Dismiss rather than chase it. Capture phase
// catches scrolls inside any container, and the containment check keeps the
// bubble's OWN overflow scrolling (long translations) from closing it.
document.addEventListener(
  "scroll",
  (e) => {
    if (!currentBubble) return;
    if (e.target instanceof Node && currentBubble.contains(e.target)) return;
    removeBubble();
  },
  { capture: true, passive: true }
);

// Mirrors content-script.js's bubble placement (see the comments there): the
// bubble is re-measured and re-placed after every content swap, and goes
// beside a tall selection rather than off the bottom of the screen.
function createBubble(rect) {
  removeBubble({ immediate: true });
  const bubble = document.createElement("div");
  bubble.id = BUBBLE_ID;
  bubble.className = "fla-bubble";
  bubble.innerHTML = `<div class="fla-loading">Translating…</div>`;
  document.body.appendChild(bubble);
  currentBubble = bubble;
  bubble._rect = rect;
  placeBubble(bubble);
  return bubble;
}

function placeBubble(bubble) {
  const rect = bubble._rect;
  if (!rect) return;
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  const spaceRight = vw - rect.right;
  const spaceLeft = rect.left;
  const spaceBelow = vh - rect.bottom;
  const beside =
    (rect.height > vh * 0.3 || spaceBelow < Math.min(bh, 140)) &&
    Math.max(spaceRight, spaceLeft) >= bw + BUBBLE_MARGIN * 2;

  let left;
  let top;
  if (beside) {
    left = spaceRight >= spaceLeft ? rect.right + BUBBLE_MARGIN : rect.left - bw - BUBBLE_MARGIN;
    top = rect.top;
  } else {
    left = rect.left;
    top = rect.bottom + BUBBLE_MARGIN;
    if (top + bh > vh - BUBBLE_MARGIN) {
      const above = rect.top - bh - BUBBLE_MARGIN;
      if (above >= BUBBLE_MARGIN) top = above;
    }
  }
  left = Math.min(Math.max(BUBBLE_MARGIN, left), Math.max(BUBBLE_MARGIN, vw - bw - BUBBLE_MARGIN));
  top = Math.min(Math.max(BUBBLE_MARGIN, top), Math.max(BUBBLE_MARGIN, vh - bh - BUBBLE_MARGIN));

  bubble.style.left = `${window.scrollX + left}px`;
  bubble.style.top = `${window.scrollY + top}px`;
}

// Deliberately NOT the same as content-script.js's copy. A PDF text layer
// emits a \n per *visual* line, so counting lines here would defer almost
// every multi-line selection, however short — count sentences instead.
function segmentCount(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

function renderBubble(bubble, { source, translation, sourceLang, targetLang }, contextSentence) {
  // Multi-line or multi-sentence selections can be practiced as a dialogue in
  // the side panel. Note PDF selections carry a \n per *visual* line (see the
  // text-layer comment below), so the practice parser may split mid-sentence —
  // the panel's textarea lets the user tidy the lines up first.
  const canPractice = source.includes("\n") || /[.!?…]\s+\S/.test(source);
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
      ${canPractice ? `<button class="fla-btn fla-practice" data-action="practice" title="Practice this dialogue aloud">🎙 Practice</button>` : ""}
    </div>
  `;

  bubble.querySelector('[data-action="speak-source"]').onclick = () => speak(source, sourceLang);
  bubble.querySelector('[data-action="speak-target"]').onclick = () => speak(translation, targetLang);
  bubble.querySelector('[data-action="save"]').onclick = () =>
    saveWord({ source, translation, sourceLang, targetLang, contextSentence });
  updateGenderChip(bubble, source, sourceLang);
  const conjBtn = bubble.querySelector('[data-action="conjugate"]');
  const conjWord = sourceLang === "fr" ? source : translation;
  conjBtn.onclick = () => requestConjugation(conjWord);
  updateConjugateButton(conjBtn, conjWord);
  bubble.querySelector('[data-action="workbook"]').onclick = () =>
    chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL", view: "vocab" });
  const practiceBtn = bubble.querySelector('[data-action="practice"]');
  if (practiceBtn) {
    practiceBtn.onclick = () =>
      chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL", view: "practice", text: source });
  }
  placeBubble(bubble);
}

// Passage-length selections wait behind a Translate button — see the fuller
// rationale on content-script.js's copy. The button appears only in this
// state; once translated the bubble is an ordinary one.
function renderDeferredBubble(bubble, source, contextSentence) {
  bubble.innerHTML = `
    <div class="fla-row">
      <span class="fla-lang">${segmentCount(source)} lines</span>
      <span class="fla-text fla-preview">${escapeHtml(source)}</span>
    </div>
    <div class="fla-actions">
      <button class="fla-btn fla-translate" data-action="translate">🌐 Translate</button>
      <button class="fla-btn fla-practice" data-action="practice" title="Practice this dialogue aloud">🎙 Practice</button>
    </div>
  `;
  bubble.querySelector('[data-action="translate"]').onclick = () => {
    bubble.innerHTML = `<div class="fla-loading">Translating…</div>`;
    placeBubble(bubble);
    requestTranslation(source, bubble, contextSentence);
  };
  bubble.querySelector('[data-action="practice"]').onclick = () =>
    chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL", view: "practice", text: source });
  placeBubble(bubble);
}

async function showSelectionBubble(sel, contextSentence) {
  const bubble = createBubble(sel.rect);
  if (segmentCount(sel.text) >= DEFER_TRANSLATE_SEGMENTS) {
    renderDeferredBubble(bubble, sel.text, contextSentence);
    return null;
  }
  return requestTranslation(sel.text, bubble, contextSentence);
}

// Only a verb can be conjugated, and the bundled verb data is the only thing
// that knows which words those are — so ask before offering the button. It
// starts disabled and is enabled only on a hit: showing it live and then
// failing on click is a worse experience than a brief moment of grey.
// CONJUGATE resolves inflected forms too ("parle" -> "parler"), and the shards
// are cached in the worker, so this is cheap after the first lookup per letter.
async function updateConjugateButton(btn, word) {
  if (!btn) return;
  const candidate = (word || "").trim();
  btn.disabled = true;

  // A phrase can't be conjugated, so don't even ask.
  if (!candidate || /\s/.test(candidate)) {
    btn.title = "Only a single verb can be conjugated";
    return;
  }

  try {
    const resp = await chrome.runtime.sendMessage({ type: "CONJUGATE", verb: candidate });
    if (resp?.ok) {
      btn.disabled = false;
      btn.title = "Show this verb's conjugation";
      return;
    }
  } catch (err) {
    // Worker asleep or the channel failed — leave it disabled rather than
    // promising something that may not work.
    console.warn("[FLA] conjugation check failed", err);
  }
  btn.title = `“${candidate}” isn't a verb`;
}

// -----------------------------
// Gender chip
//
// Same rule content/annotator.js and the side panel both use: nouns only, and
// plural wins over gender. A known noun whose gender the lexicon doesn't carry
// gets nothing rather than a guess.
//
// The mark is a line STYLE as well as a colour — solid / dotted / dashed —
// because the gender colours are user-chosen and can't be relied on to carry
// contrast, and colour alone excludes anyone who can't separate the hues.
// -----------------------------

const GENDER_LABEL = { masculine: "m.", feminine: "f.", plural: "pl." };

function genderFromLexicon(entry) {
  if (!entry || entry.pos !== "NOM") return null;
  if (entry.number === "p") return "plural";
  if (entry.gender === "m") return "masculine";
  if (entry.gender === "f") return "feminine";
  return null;
}

// Looked up separately from TRANSLATE rather than bolted onto its response:
// TRANSLATE takes arbitrary text (a whole passage), while this only ever makes
// sense for a single word, and LOOKUP_WORDS already exists for exactly this.
async function updateGenderChip(bubble, word, sourceLang) {
  const candidate = (word || "").trim();
  if (!bubble || sourceLang !== "fr" || !candidate || /\s/.test(candidate)) return;

  let entry = null;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "LOOKUP_WORDS", words: [candidate] });
    entry = resp?.entries?.[candidate] || null;
  } catch (err) {
    return; // worker asleep or channel failed — the chip is an extra, not a promise
  }

  const gender = genderFromLexicon(entry);
  // The bubble may have been replaced while the lookup was in flight.
  if (!gender || !bubble.isConnected) return;

  const row = bubble.querySelector(".fla-row");
  const text = row?.querySelector(".fla-text");
  if (!text) return;

  const chip = document.createElement("span");
  chip.className = `fla-gender fla-gender--${gender}`;
  chip.textContent = GENDER_LABEL[gender];
  chip.title = gender === "plural" ? "plural noun" : `${gender} noun`;
  text.insertAdjacentElement("afterend", chip);
  placeBubble(bubble);
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

// Mirrors content/content-script.js's copy — see the fuller comment there.
// This measures with a probe Range instead of identity-matching text nodes in
// a walker, which never matched a Range anchored to an ELEMENT and so fell
// through to a fallback returning the first 300 characters of the container.
// That bites hardest here: a PDF text layer has no paragraph structure, so the
// container is the WHOLE PAGE, and the "context sentence" saved with a word
// was text from an unrelated part of it.
function textOffsetOf(container, node, nodeOffset) {
  const probe = document.createRange();
  probe.selectNodeContents(container);
  probe.setEnd(node, nodeOffset);
  return probe.toString().length;
}

function sliceSentence(text, start, end) {
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
  // A PDF page whose sentence boundaries didn't survive text extraction has no
  // natural end, and the whole page is not "a sentence".
  return text.slice(sentStart, sentEnd).trim().slice(0, MAX_CONTEXT_CHARS);
}

function getContextSentence(range) {
  if (!range) return "";
  const container = findBlockAncestor(range.commonAncestorContainer);
  const text = container.textContent || "";

  let start = null;
  let end = null;
  try {
    start = textOffsetOf(container, range.startContainer, range.startOffset);
    end = textOffsetOf(container, range.endContainer, range.endOffset);
  } catch {
    // The range isn't inside this container (detached node, re-rendered page).
  }

  if (start != null && end != null && start <= text.length) {
    return sliceSentence(text, start, end);
  }

  // Fall back to the word's OWN text node, never an arbitrary slice of the
  // page: unrelated context is worse than terse context, because it reads as
  // correct and is silently wrong.
  const node = range.startContainer;
  const local = node?.textContent || "";
  if (local) return sliceSentence(local, range.startOffset, range.startOffset);
  return range.toString().trim().slice(0, MAX_CONTEXT_CHARS);
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
    await showSelectionBubble(sel, getContextSentence(sel.range));
    return;
  }

  removeBubble();
  if (isInteractiveTarget(e.target)) return;

  const word = getWordAtPoint(e.clientX, e.clientY);
  if (!word || !word.text) return;

  const contextSentence = getContextSentence(word.range);
  const bubble = createBubble(word.rect);
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
    const bubble = createBubble(word.rect);
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
      placeBubble(bubble);
      return null;
    }
    renderBubble(bubble, resp, contextSentence);
    return resp;
  } catch (err) {
    bubble.innerHTML = `<div class="fla-error">Translation failed</div>`;
    placeBubble(bubble);
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
    const resp = await chrome.runtime.sendMessage({
      type: "SAVE_WORD",
      entry: { ...entry, url: pdfState.pdfUrl, pdfTitle: pdfState.docTitle }
    });
    // Already in this PDF's workbook — the save refreshed it rather than
    // adding a second copy.
    flashBubbleFeedback(resp?.duplicate ? "Already saved — updated ✓" : "Saved ✓");
  } catch (err) {
    console.error("[FLA pdf-viewer] save failed", err);
  }
}

async function handleSaveSelectionShortcut() {
  const sel = getSelectionText();
  if (!sel) return;

  const contextSentence = getContextSentence(sel.range);
  const resp = await showSelectionBubble(sel, contextSentence);
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
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "CONJUGATE", verb });
  } catch (err) {
    // Message channel itself failed (e.g. the service worker was asleep and
    // didn't wake in time) — different failure than "not a verb," but just
    // as silent to the user if we don't say something here.
    console.error("[FLA pdf-viewer] conjugate lookup failed", err);
    flashBubbleFeedback("Lookup failed — try again.", "error");
    return;
  }
  if (resp?.error) {
    flashBubbleFeedback(resp.error, "error");
    return;
  }
  await chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL", view: "conjugation", verb });
}

// tone "ok" is the sage confirmation pill; "error" is the same shape in the
// error colour. They shared one style before, which meant "Lookup failed"
// arrived in the same green as "Saved ✓" — the colour that means the opposite.
function flashBubbleFeedback(msg, tone = "ok") {
  if (!currentBubble) return;
  const flash = document.createElement("div");
  flash.className = tone === "error" ? "fla-flash fla-flash--error" : "fla-flash";
  flash.textContent = msg;
  currentBubble.appendChild(flash);
  // An error is worth reading; a confirmation isn't.
  setTimeout(() => flash.remove(), tone === "error" ? 3000 : 1500);
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
  if (msg.type === "GET_SELECTION") {
    // Same contract as content-script.js — the popup's "practice selection"
    // works over a PDF too. This page is an extension page, not a content
    // script, so the popup reaches it by runtime broadcast rather than
    // tabs.sendMessage; the msg.type filter above is what keeps that safe.
    //
    // That broadcast hits *every* open viewer tab at once, so answer only if
    // this one is both on screen and actually holding a selection — otherwise
    // a background PDF could win the race with an empty reply.
    const text = document.visibilityState === "visible" ? getSelectionText()?.text : "";
    if (text) sendResponse({ text });
  }
});

// Initial state, plus live cross-tab reactivity (this tab might not be
// active when the user toggles hover mode from the popup/Alt+T — annotator.js
// established this chrome.storage.onChanged pattern in Phase 2 for exactly
// this kind of per-tab setting that shouldn't require the tab to be focused).
// content/popup.css themes the bubble off these two classes, and on a host
// page content/annotator.js is what sets them. It's a content script, so it
// never runs on this extension page — mirror it here or the PDF bubble ignores
// the user's Light/Dark choice. Neither class set means "follow the OS", which
// is what the stylesheet's media query handles.
function applyThemeClasses(config = {}) {
  const root = document.documentElement;
  root.classList.toggle("fla-theme-dark", config.themeMode === "dark");
  root.classList.toggle("fla-theme-light", config.themeMode === "light");
}

chrome.storage.local.get("config").then(({ config = {} }) => {
  hoverModeEnabled = !!config.hoverModeEnabled;
  applyThemeClasses(config);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.config) {
    hoverModeEnabled = !!changes.config.newValue?.hoverModeEnabled;
    applyThemeClasses(changes.config.newValue || {});
  }
});
