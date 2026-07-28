// content-script.js
// Runs on every page. Detects text selection + hover, injects a floating
// translation bubble, and talks to the service worker for translations.

const BUBBLE_ID = "fla-bubble";
const HOVER_DEBOUNCE_MS = 400;

let hoverModeEnabled = false;
let cursorFollowEnabled = true; // default mode: word-under-cursor indicator, click to translate
let currentBubble = null;
let hoverTimer = null;
let currentReticle = null;
let reticleRAF = null;

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
}

// -----------------------------
// Cursor-follow reticle (default mode)
// -----------------------------

function removeReticle() {
  if (currentReticle) {
    currentReticle.remove();
    currentReticle = null;
  }
}

function updateReticle(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (isInteractiveTarget(el) || (currentBubble && currentBubble.contains(el))) {
    removeReticle();
    return;
  }

  const word = getWordAtPoint(clientX, clientY);
  if (!word || !word.text) {
    removeReticle();
    return;
  }

  if (!currentReticle) {
    currentReticle = document.createElement("div");
    currentReticle.className = "fla-reticle";
    document.body.appendChild(currentReticle);
  }
  currentReticle.textContent = word.text;
  currentReticle.style.left = `${window.scrollX + word.rect.left}px`;
  currentReticle.style.top = `${window.scrollY + word.rect.top - 22}px`;
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

document.addEventListener("mouseup", async (e) => {
  // Ignore clicks inside our own bubble or reticle
  if (currentBubble && currentBubble.contains(e.target)) return;
  if (currentReticle && currentReticle.contains(e.target)) return;

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

  // Cursor-follow mode: a plain click (no drag-selection) translates the
  // word under the cursor. Hover mode replaces this with dwell-to-reveal,
  // so it takes priority when both happen to be on.
  if (!cursorFollowEnabled || hoverModeEnabled) return;
  if (isInteractiveTarget(e.target)) return;

  const word = getWordAtPoint(e.clientX, e.clientY);
  if (!word || !word.text) return;

  removeReticle();
  const contextSentence = getContextSentence(word.range);
  const x = window.scrollX + word.rect.left;
  const y = window.scrollY + word.rect.bottom + 8;
  const bubble = createBubble(x, y);
  await requestTranslation(word.text, bubble, contextSentence);
});

// -----------------------------
// Hover mode (dwell-to-reveal) / cursor-follow reticle
// -----------------------------

document.addEventListener("mousemove", (e) => {
  if (hoverModeEnabled) {
    removeReticle();
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(async () => {
      if (isInteractiveTarget(e.target)) return;
      const word = getWordAtPoint(e.clientX, e.clientY);
      if (!word || !word.text) return;

      const contextSentence = getContextSentence(word.range);
      const x = window.scrollX + word.rect.left;
      const y = window.scrollY + word.rect.bottom + 8;
      const bubble = createBubble(x, y);
      await requestTranslation(word.text, bubble, contextSentence);
    }, HOVER_DEBOUNCE_MS);
    return;
  }

  if (!cursorFollowEnabled) {
    removeReticle();
    return;
  }

  const { clientX, clientY } = e;
  if (reticleRAF) return;
  reticleRAF = requestAnimationFrame(() => {
    reticleRAF = null;
    updateReticle(clientX, clientY);
  });
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
    await chrome.runtime.sendMessage({ type: "SAVE_WORD", entry });
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
  if (msg.type === "SET_CURSOR_MODE") {
    cursorFollowEnabled = !!msg.enabled;
    if (!cursorFollowEnabled) removeReticle();
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
chrome.storage.local.get(["hoverModeEnabled", "cursorFollowMode"]).then((s) => {
  hoverModeEnabled = !!s.hoverModeEnabled;
  cursorFollowEnabled = s.cursorFollowMode !== false; // default on
});
