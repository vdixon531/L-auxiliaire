// content-script.js
// Runs on every page. Detects text selection + hover, injects a floating
// translation bubble, and talks to the service worker for translations.

const BUBBLE_ID = "fla-bubble";
const HOVER_DEBOUNCE_MS = 400;

let hoverModeEnabled = false;
let currentBubble = null;
let hoverTimer = null;
let isMouseDown = false; // suppresses the hover-dwell popup while a drag-selection is in progress

// Elements a stray click/hover shouldn't hijack — normal page interaction
// (nav links, buttons, form fields) takes priority over translate-on-click.
const INTERACTIVE_SELECTOR =
  "a, button, input, textarea, select, label, [role='button'], [contenteditable], [contenteditable='true']";

function isInteractiveTarget(el) {
  return !!(el && el.closest && el.closest(INTERACTIVE_SELECTOR));
}

// -----------------------------
// Bubble UI
// -----------------------------

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
  bubble.innerHTML = `
    <div class="fla-loading">Translating…</div>
  `;
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

  bubble.querySelector('[data-action="speak-source"]').onclick = () =>
    speak(source, sourceLang);
  bubble.querySelector('[data-action="speak-target"]').onclick = () =>
    speak(translation, targetLang);
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

// -----------------------------
// TTS
// -----------------------------

function speak(text, langCode) {
  // langCode is 'fr' or 'en' — normalize to BCP-47
  const lang = langCode === "fr" ? "fr-FR" : "en-US";
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  utter.rate = 0.9; // slightly slower is better for learners
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

// -----------------------------
// Context sentence extraction
// -----------------------------

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

// Range coordinates are per-text-node; walk the container's text nodes to
// translate them into offsets within the container's flattened text.
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

// -----------------------------
// Selection handling
// -----------------------------

function getSelectionText() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  return { text, rect, range };
}

// A selection stays highlighted on the page (and its translation bubble
// stays up) until the user clicks elsewhere to collapse it — hover mode
// must not steal that bubble out from under them just because the cursor
// happens to drift over some other word in the meantime.
function hasActiveSelection() {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
}

document.addEventListener("mousedown", () => {
  isMouseDown = true;
});

document.addEventListener("mouseup", async (e) => {
  isMouseDown = false;
  // Ignore clicks inside our own bubble
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

  // Click-to-translate a single word is always available — hover mode (below)
  // is purely additive on top of it, not an alternative.
  if (isInteractiveTarget(e.target)) return;

  const word = getWordAtPoint(e.clientX, e.clientY);
  if (!word || !word.text) return;

  const contextSentence = getContextSentence(word.range);
  const x = window.scrollX + word.rect.left;
  const y = window.scrollY + word.rect.bottom + 8;
  const bubble = createBubble(x, y);
  await requestTranslation(word.text, bubble, contextSentence);
});

// -----------------------------
// Hover mode (dwell-to-reveal) — optional, additive on top of click-to-translate
// -----------------------------

document.addEventListener("mousemove", (e) => {
  if (!hoverModeEnabled) return;
  clearTimeout(hoverTimer);
  // A drag-selection in progress fires mousemove continuously too — without
  // this guard, the dwell timer would keep popping up single-word bubbles
  // over whatever word the cursor passes, fighting with the multi-word
  // selection the user is trying to make.
  if (isMouseDown) return;
  // A completed selection stays highlighted (and its own bubble stays up)
  // until the user clicks elsewhere — don't replace it just because the
  // cursor drifted over another word afterward.
  if (hasActiveSelection()) return;

  hoverTimer = setTimeout(async () => {
    if (isMouseDown) return; // drag may have started during the debounce window
    if (hasActiveSelection()) return; // selection may have been made during the debounce window
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
  const range = document.caretRangeFromPoint
    ? document.caretRangeFromPoint(x, y)
    : null;
  if (!range) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent;
  const offset = range.startOffset;

  // Expand outward to word boundaries (Unicode-aware for accents)
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
  // isn't actually over any text — over an image, a margin, empty space
  // beside a short line, etc. — which otherwise makes hover/click "reach"
  // for whatever word happens to be closest. Reject unless the point truly
  // falls inside the resolved word's own rect(s) (checking every line rect,
  // not just the bounding box, since a wrapped word's bounding box can span
  // a gap that isn't actually part of the word on either line).
  const rects = wordRange.getClientRects();
  const inside = [...rects].some(
    (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  );
  if (!inside) return null;

  return { text: wordText, rect: wordRange.getBoundingClientRect(), range: wordRange };
}

// -----------------------------
// Service worker messaging
// -----------------------------

async function requestTranslation(text, bubble, contextSentence) {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "TRANSLATE",
      text,
      contextSentence
    });
    if (resp?.error) {
      bubble.innerHTML = `<div class="fla-error">${escapeHtml(resp.error)}</div>`;
      return null;
    }
    renderBubble(bubble, resp, contextSentence);
    return resp;
  } catch (err) {
    bubble.innerHTML = `<div class="fla-error">Translation failed</div>`;
    console.error("[FLA]", err);
    return null;
  }
}

async function saveWord(entry) {
  try {
    // pageTitle labels this page's workbook in the side panel's workbook
    // list — same idea as pdf-viewer/viewer.js's pdfTitle for PDFs, just for
    // regular web pages, which otherwise have nothing readable but the URL.
    await chrome.runtime.sendMessage({ type: "SAVE_WORD", entry: { ...entry, pageTitle: document.title } });
    flashBubbleFeedback("Saved ✓");
  } catch (err) {
    console.error("[FLA] save failed", err);
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
  const resp = await chrome.runtime.sendMessage({
    type: "CONJUGATE",
    verb
  });
  if (resp?.error) {
    flashBubbleFeedback(resp.error);
    return;
  }
  // Open side panel to show the table
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

// -----------------------------
// Toggles from popup / commands
// -----------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SET_HOVER_MODE") {
    hoverModeEnabled = !!msg.enabled;
    if (!hoverModeEnabled) removeBubble();
    sendResponse({ ok: true });
  }
  if (msg.type === "TRANSLATE_STATUS") {
    // One-time notice while Chrome downloads the on-device language pack —
    // otherwise the bubble just sits on "Translating…" with no feedback.
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

// Load initial mode state
chrome.storage.local.get("config").then(({ config = {} }) => {
  hoverModeEnabled = !!config.hoverModeEnabled;
});
