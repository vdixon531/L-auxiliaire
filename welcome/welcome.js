// welcome.js
//
// First-run tutorial. Opened once by background/service-worker.js's onInstalled
// handler, and reachable afterwards from Settings → Replay tutorial.
//
// The demo paragraph below is a reproduction of a real page, not a screenshot:
// its words carry the genuine .fla-word--* classes content/annotator.js emits,
// its bubble is built from the same markup as content/content-script.js's
// renderBubble(), and clicking a word sends a real TRANSLATE message. A content
// script can't run on a chrome-extension:// page, so the extension can't demo
// itself for real — this is as close as it gets, and it means the reading-aids
// chapter can switch the aids on and have the paragraph respond exactly as a
// live page would.

import { initThemeMode } from "../lib/theme-mode.js";
import { chevron, setFlipped } from "../lib/flip.js";
import {
  TOUR_IDS,
  runTour,
  markTourSeen,
  markChapterSeen,
  getTourState,
  isTourActive,
  advanceTour,
  showHint,
  dismissHint,
  para
} from "../lib/tour.js";

const $ = (id) => document.getElementById(id);

// -----------------------------
// The demo paragraph
// -----------------------------

// [text, classes] — classes match content/annotator.js exactly:
//   fla-word            every matched word
//   fla-word--masculine / --feminine / --plural   nouns only; plural beats gender
// Everything is off until the user turns it on, which is the whole point of the
// reading-aids chapter.
const DEMO = [
  ["Le", "fla-word"],
  [" "],
  ["petit", "fla-word"],
  [" "],
  ["déjeuner", "fla-word fla-word--masculine"],
  [" "],
  ["est", "fla-word"],
  [" "],
  ["prêt", "fla-word"],
  [" "],
  ["sur", "fla-word"],
  [" "],
  ["la", "fla-word"],
  [" "],
  ["table", "fla-word fla-word--feminine"],
  [" "],
  ["de", "fla-word"],
  [" "],
  ["la", "fla-word"],
  [" "],
  ["terrasse", "fla-word fla-word--feminine"],
  [". "],
  ["La", "fla-word"],
  [" "],
  ["lumière", "fla-word fla-word--feminine"],
  [" "],
  ["du", "fla-word"],
  [" "],
  ["matin", "fla-word fla-word--masculine"],
  [" "],
  ["traverse", "fla-word"],
  [" "],
  ["les", "fla-word"],
  [" "],
  ["grandes", "fla-word"],
  [" "],
  ["fenêtres", "fla-word fla-word--plural"],
  [", "],
  ["et", "fla-word"],
  [" "],
  ["le", "fla-word"],
  [" "],
  ["chat", "fla-word fla-word--masculine"],
  [" "],
  ["dort", "fla-word"],
  [" "],
  ["encore", "fla-word"],
  [" "],
  ["près", "fla-word"],
  [" "],
  ["de", "fla-word"],
  [" "],
  ["la", "fla-word"],
  [" "],
  ["porte", "fla-word fla-word--feminine"],
  [". "],
  // Two more sentences so the paragraph is four long. That's the passages
  // chapter's whole point: DEFER_TRANSLATE_SEGMENTS is 4, so selecting the
  // article has to actually cross the threshold to show the 🌐 Translate
  // button the chapter is about.
  ["Dehors", "fla-word"],
  [", "],
  ["un", "fla-word"],
  [" "],
  ["chien", "fla-word fla-word--masculine"],
  [" "],
  ["aboie", "fla-word"],
  [". "],
  ["Le", "fla-word"],
  [" "],
  ["café", "fla-word fla-word--masculine"],
  [" "],
  ["refroidit", "fla-word"],
  [" "],
  ["lentement", "fla-word"],
  ["."]
];

// A selection of four lines-or-sentences or more gets a preview and a
// 🌐 Translate button instead of an immediate translation. Mirrors
// content/content-script.js's constant of the same name.
const DEFER_TRANSLATE_SEGMENTS = 4;


// Used only when on-device translation is unavailable (an older Chrome, or no
// model for this machine), so the tutorial still teaches the interaction
// instead of dead-ending on an error.
const FALLBACK_GLOSS = {
  déjeuner: "lunch; (petit déjeuner) breakfast",
  table: "table",
  terrasse: "terrace",
  lumière: "light",
  matin: "morning",
  traverse: "crosses, goes through",
  fenêtres: "windows",
  chat: "cat",
  dort: "sleeps",
  porte: "door",
  prêt: "ready",
  grandes: "large, big",
  dehors: "outside",
  chien: "dog",
  aboie: "barks",
  café: "coffee",
  refroidit: "cools down",
  lentement: "slowly"
};

const COGNATE_OF = { table: "table", terrasse: "terrace", traverse: "traverse" };

function buildDemo() {
  const article = $("demoArticle");
  article.replaceChildren();
  for (const [text, cls] of DEMO) {
    if (!cls) {
      article.appendChild(document.createTextNode(text));
      continue;
    }
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    span.tabIndex = 0;
    span.setAttribute("role", "button");
    span.setAttribute("aria-label", `Translate ${text}`);
    if (COGNATE_OF[text.toLowerCase()]) {
      span.title = `Cognate of English "${COGNATE_OF[text.toLowerCase()]}"`;
    }
    // Step 3 spotlights this one specifically, and steps 4-6 all work from
    // the bubble it opens.
    if (text.toLowerCase() === "traverse") span.id = "demoWordTraverse";
    // A drag that ends on a word fires this span's click as well as the
    // document's mouseup. The selection is the more specific intent, so the
    // word handler stands down — otherwise a dragged phrase would flash a
    // one-word bubble before the selection bubble replaced it.
    span.addEventListener("click", () => {
      if (selectionJustMade) return;
      showBubbleFor(span, { fromUser: true });
    });
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        showBubbleFor(span, { fromUser: true });
      }
    });
    article.appendChild(span);
  }
}

// -----------------------------
// The bubble — same markup as content/content-script.js's renderBubble()
// -----------------------------

let currentBubble = null;

// Fades out rather than vanishing. `immediate` is for the case where a new
// bubble is replacing this one — there, a fade would leave two on screen.
function removeBubble({ immediate = false } = {}) {
  const bubble = currentBubble;
  currentBubble = null;
  if (!bubble) return;

  // Whatever the bubble was reading belongs to the bubble. Leaving a voice
  // talking after the thing that started it is gone is disorienting, and on a
  // long passage it can run for a while.
  window.speechSynthesis?.cancel();

  if (immediate) {
    bubble.remove();
    return;
  }
  bubble.classList.add("fla-bubble--out");
  setTimeout(() => bubble.remove(), 160);
}

// Click anywhere that isn't the bubble or another word, and it goes away. A
// popover you can only close by pressing its own button reads as a trap.
document.addEventListener("click", (e) => {
  // The click that ends a drag-selection must not close the bubble that
  // selection just opened. Cleared here because this listener is on the
  // document, so it runs after the word spans' own handlers.
  const wasSelection = selectionJustMade;
  selectionJustMade = false;
  if (wasSelection) return;
  if (!currentBubble) return;
  // While a tour is running the bubble belongs to the tour, not to the click:
  // steps 4-6 spotlight its buttons, and any stray click that dismissed it
  // would leave those steps pointing at nothing.
  if (isTourActive()) return;
  if (currentBubble.contains(e.target)) return;
  // The word's own handler already ran and opened a replacement.
  if (e.target.closest?.(".fla-word")) return;
  removeBubble();
});

document.addEventListener("keydown", (e) => {
  // Escape belongs to the tour while one is running — it closes that instead.
  if (e.key === "Escape" && currentBubble && !isTourActive()) removeBubble();
});

// Same rule as a real page: scrolling dismisses it, but scrolling inside it
// (a long translation) does not.
document.addEventListener(
  "scroll",
  (e) => {
    if (!currentBubble || isTourActive()) return;
    if (e.target instanceof Node && currentBubble.contains(e.target)) return;
    removeBubble();
  },
  { capture: true, passive: true }
);

function makeBubble(anchor) {
  removeBubble({ immediate: true });
  const bubble = document.createElement("div");
  bubble.className = "fla-bubble";
  bubble.id = "fla-bubble";
  bubble.innerHTML = `<div class="fla-loading">Translating…</div>`;
  document.body.appendChild(bubble);
  currentBubble = bubble;
  placeBubble(bubble, anchor);
  return bubble;
}

// A pared-down placeBubble(): the demo article is never near the viewport
// bottom, so this only needs the below-then-clamp half of the content script's
// logic, not its beside-a-tall-selection case.
//
// `anchor` is the element for a clicked word, or the live Range for a
// selection — both can be re-measured, which is what makes re-placing on
// resize possible.
function rectOf(anchor) {
  // An Element or a Range is re-measured live; both move when the page
  // reflows (which is exactly what happens when the side panel opens and
  // narrows the viewport). A bare DOMRect is a snapshot and can't be.
  if (anchor instanceof Element || anchor instanceof Range) return anchor.getBoundingClientRect();
  return anchor;
}

function placeBubble(bubble, anchor) {
  // Remembered so the bubble can be put back in the right place when the
  // viewport changes size — see the resize listener below.
  if (anchor) bubble._anchor = anchor;
  const r = rectOf(bubble._anchor);
  if (!r) return;
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  let left = r.left;
  let top = r.bottom + 8;
  if (top + bh > vh - 8 && r.top - bh - 8 >= 8) top = r.top - bh - 8;
  left = Math.min(Math.max(8, left), Math.max(8, vw - bw - 8));
  top = Math.min(Math.max(8, top), Math.max(8, vh - bh - 8));

  bubble.style.left = `${window.scrollX + left}px`;
  bubble.style.top = `${window.scrollY + top}px`;
}

// Opening the side panel narrows this tab's viewport, and the paragraph
// reflows under a bubble that was positioned in page coordinates against the
// old, wider one — leaving it sitting half under the panel's edge, with the
// tour spotlighting a button that's no longer fully on screen. The tour's own
// callout already re-places itself on resize (lib/tour.js); this is the same
// treatment for the bubble it points into. Debounced because Chrome resizes
// the viewport continuously while the panel slides open.
let bubbleResizeTimer = null;
window.addEventListener("resize", () => {
  if (!currentBubble) return;
  clearTimeout(bubbleResizeTimer);
  bubbleResizeTimer = setTimeout(() => {
    if (currentBubble) placeBubble(currentBubble);
  }, 60);
});


// Set while step 3 is showing, so clicking the word it spotlights carries the
// tour forward — Next is still there for anyone who doesn't.
let awaitingTraverseClick = false;

async function showBubbleFor(span, { fromUser = false } = {}) {
  if (fromUser && awaitingTraverseClick) {
    awaitingTraverseClick = false;
    // Let the bubble render before the next step measures one of its buttons.
    setTimeout(() => advanceTour(), 350);
  }
  const word = span.textContent.trim();
  const bubble = makeBubble(span);
  $("demoHint").textContent = "";

  const wordRange = document.createRange();
  wordRange.selectNode(span);
  const contextSentence = contextSentenceFor(wordRange);

  const { translation, sourceLang, targetLang, note } = await translateText(word, contextSentence);
  if (bubble !== currentBubble) return; // superseded by a later click

  renderBubble(bubble, span, { word, translation, sourceLang, targetLang, contextSentence });
  setStatus(note, false);
}

// The sentence containing `range`, measured with a probe Range against the
// demo article's own text — same principle as content-script.js's real
// getContextSentence() (measure, never hardcode or identity-match a text
// node), sized down for what this DOM actually needs: one known flat
// container, no nested blocks to walk up through, and every Range here is
// freshly built against the article's own live DOM, so the real function's
// detached-node fallback doesn't apply. A single shared CONTEXT_SENTENCE
// constant used to feed every word regardless of which sentence it was
// actually in — harmless for words in the first sentence, silently wrong for
// "traverse", which lives in the second.
function contextSentenceFor(range) {
  const article = $("demoArticle");
  const text = article.textContent || "";
  const offsetOf = (node, nodeOffset) => {
    const probe = document.createRange();
    probe.selectNodeContents(article);
    probe.setEnd(node, nodeOffset);
    return probe.toString().length;
  };
  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);

  const BOUNDARY = /[.!?]/;
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

/** One real TRANSLATE round-trip, falling back to a bundled gloss so the
 *  tutorial teaches the interaction rather than dead-ending on an error. Shared
 *  by the click path and the selection path. */
async function translateText(text, contextSentence) {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "TRANSLATE",
      text,
      contextSentence
    });
    if (resp?.error) throw new Error(resp.error);
    if (resp?.translation) {
      return {
        translation: resp.translation,
        sourceLang: resp.sourceLang || "fr",
        targetLang: resp.targetLang || "en",
        note: ""
      };
    }
  } catch (err) {
    console.warn("[FLA welcome] live translation unavailable, using fallback", err);
  }
  return {
    translation: FALLBACK_GLOSS[text.trim().toLowerCase()] || "—",
    sourceLang: "fr",
    targetLang: "en",
    note: "Showing a built-in gloss — on-device translation isn't available here yet."
  };
}

// -----------------------------
// Selections
//
// The other half of the in-page interaction: drag across more than one word and
// the whole selection is translated. Reproduced here for the same reason the
// click path is — a content script can't run on a chrome-extension:// page, so
// the passages chapter has to be able to demonstrate the real behaviour,
// including the deferred 🌐 Translate button, on this paragraph.
// -----------------------------

// Set for the duration of the click that ends a drag, so the word under the
// cursor and the document's dismiss-on-click handler both stand down.
let selectionJustMade = false;
// Set while the passages chapter's first step is showing, so a real selection
// carries the tour forward.
let awaitingPassageSelection = false;

// Mirrors content/content-script.js's segmentCount(): newlines first, sentences
// as the fallback, so the count matches the number of turns Practice would make.
function segmentCount(text) {
  const lines = String(text || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length > 1) return lines.length;
  return String(text || "")
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/** The current selection, if it's a multi-word one inside the demo paragraph.
 *  A single word is the click path's job, not this one. */
function demoSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text || !/\s/.test(text)) return null;
  const range = sel.getRangeAt(0);
  if (!$("demoArticle").contains(range.commonAncestorContainer)) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { text, rect, range };
}

function clearSelection() {
  window.getSelection()?.removeAllRanges();
}

// Only a drag that STARTED in the paragraph counts. Without this, any mouseup
// anywhere re-reads whatever is still selected — so pressing the deferred
// bubble's own 🌐 Translate button (with the paragraph still highlighted behind
// it) would rebuild the bubble out from under the button before its click could
// land, and the button would look dead.
let dragStartedInDemo = false;

document.addEventListener("mousedown", (e) => {
  dragStartedInDemo = $("demoArticle").contains(e.target);
});

document.addEventListener("mouseup", () => {
  if (!dragStartedInDemo) return;
  dragStartedInDemo = false;
  const sel = demoSelection();
  if (!sel) return;
  selectionJustMade = true;
  showSelectionBubble(sel, { fromUser: true });
});

async function showSelectionBubble(sel, { fromUser = false } = {}) {
  if (fromUser && awaitingPassageSelection) {
    awaitingPassageSelection = false;
    // Let the bubble render before the next step measures a button inside it.
    setTimeout(() => advanceTour(), 350);
  }

  const bubble = makeBubble(sel.range);
  $("demoHint").textContent = "";
  const contextSentence = contextSentenceFor(sel.range);

  if (segmentCount(sel.text) >= DEFER_TRANSLATE_SEGMENTS) {
    renderDeferredBubble(bubble, sel, contextSentence);
    return;
  }

  const { translation, sourceLang, targetLang, note } = await translateText(sel.text, contextSentence);
  if (bubble !== currentBubble) return; // superseded
  renderBubble(bubble, sel.range, {
    word: sel.text,
    translation,
    sourceLang,
    targetLang,
    contextSentence,
    practiceText: segmentCount(sel.text) > 1 ? sel.text : null
  });
  setStatus(note, false);
}

// The passage-length case, exactly as content/content-script.js renders it:
// show what was selected and what can be done with it, but don't spend a
// translation until asked. The Translate button exists ONLY here.
function renderDeferredBubble(bubble, sel, contextSentence) {
  const segments = segmentCount(sel.text);
  bubble.innerHTML = `
    <div class="fla-row">
      <span class="fla-lang">${segments} lines</span>
      <span class="fla-text fla-preview">${escapeHtml(sel.text)}</span>
    </div>
    <div class="fla-actions">
      <button class="fla-btn fla-translate" data-action="translate">🌐 Translate</button>
      <button class="fla-btn fla-practice" data-action="practice" title="Practice this dialogue aloud">🎙 Practice</button>
    </div>
  `;
  bubble.querySelector('[data-action="translate"]').onclick = async () => {
    bubble.innerHTML = `<div class="fla-loading">Translating…</div>`;
    placeBubble(bubble, sel.range);
    const { translation, sourceLang, targetLang, note } = await translateText(sel.text, contextSentence);
    if (bubble !== currentBubble) return;
    renderBubble(bubble, sel.range, {
      word: sel.text,
      translation,
      sourceLang,
      targetLang,
      contextSentence,
      practiceText: sel.text
    });
    setStatus(note, false);
  };
  bubble.querySelector('[data-action="practice"]').onclick = () => openPractice(sel.text);
  placeBubble(bubble, sel.range);
}

/** The deferred bubble, rebuilt only if it isn't already up. The passages
 *  chapter's last three steps all need it, and re-selecting the paragraph on
 *  every one of them would tear down and recreate the bubble underneath the
 *  spotlight that just measured it. */
async function ensureDeferredBubble() {
  if (currentBubble?.querySelector(".fla-translate")) return;
  await selectWholeDemo();
}

/** Select the whole demo paragraph and open its bubble. The passages chapter
 *  uses this to put the deferred state on screen without asking the user to
 *  drag exactly far enough to trigger it. */
async function selectWholeDemo() {
  const article = $("demoArticle");
  const range = document.createRange();
  range.selectNodeContents(article);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  await showSelectionBubble({ text: article.textContent.trim(), rect: range.getBoundingClientRect(), range });
}

function renderBubble(bubble, anchor, { word, translation, sourceLang, targetLang, contextSentence, practiceText = null }) {
  bubble.innerHTML = `
    <div class="fla-row">
      <span class="fla-lang">${sourceLang}</span>
      <span class="fla-text">${escapeHtml(word)}</span>
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
      ${practiceText ? `<button class="fla-btn fla-practice" data-action="practice" title="Practice this dialogue aloud">🎙 Practice</button>` : ""}
    </div>
  `;

  bubble.querySelector('[data-action="speak-source"]').onclick = () => speak(word, "fr");
  bubble.querySelector('[data-action="speak-target"]').onclick = () => speak(translation, "en");
  // All three buttons do the real thing, including during the tour — a
  // tutorial that mimes its own features teaches the mime. Each also asks the
  // side panel to spotlight where the result lands, so the user's eye is led
  // from the button they pressed to the thing that changed.
  const conjBtn = bubble.querySelector('[data-action="conjugate"]');
  conjBtn.onclick = () => requestConjugation(word, bubble);
  updateConjugateButton(conjBtn, word);

  bubble.querySelector('[data-action="workbook"]').onclick = async () => {
    await spotlightInPanel({
      target: ".vocab-layout",
      title: "Your workbook",
      body: "Every word you save lives here, grouped into one workbook per page and per PDF."
    });
    openWorkbook();
  };

  bubble.querySelector('[data-action="save"]').onclick = () =>
    saveDemoWord(bubble, word, translation, sourceLang, targetLang, contextSentence);

  const practiceBtn = bubble.querySelector('[data-action="practice"]');
  if (practiceBtn) practiceBtn.onclick = () => openPractice(practiceText);

  placeBubble(bubble, anchor);
}

// Same route the in-page bubble takes: the intent rides on OPEN_SIDEPANEL and
// the panel picks it up. Spotlighted first, for the same reason every other
// real action here is — the result lands in a document this page can't dim.
async function openPractice(text) {
  await spotlightInPanel({
    target: "#practice",
    title: "Say it out loud",
    body: "The panel reads one side of the dialogue and scores how you say the other."
  });
  await chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL", view: "practice", text });
}

/** Guarantee a bubble exists so a tour step can point at one of its buttons.
 *  `word` picks a specific one — the conjugation chapter needs a verb open,
 *  not whichever noun happened to be clicked. */
async function ensureDemoBubble(word) {
  if (word) {
    const wanted = [...$("demoArticle").querySelectorAll(".fla-word")].find(
      (el) => el.textContent.trim().toLowerCase() === word.toLowerCase()
    );
    if (wanted && currentBubble?.querySelector(".fla-text")?.textContent.trim() === word) return;
    if (wanted) {
      await showBubbleFor(wanted);
      return;
    }
  }
  if (currentBubble?.querySelector(".fla-save")) return;
  const fallback =
    $("demoArticle").querySelector(".fla-word--masculine") ||
    $("demoArticle").querySelector(".fla-word");
  if (fallback) await showBubbleFor(fallback);
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

// Mirrors content-script.js's flashBubbleFeedback: sage for a confirmation,
// the error colour for a failure — never the same pill for both.
function flash(bubble, msg, tone = "ok") {
  const el = document.createElement("div");
  el.className = tone === "error" ? "fla-flash fla-flash--error" : "fla-flash";
  el.textContent = msg;
  bubble.appendChild(el);
  setTimeout(() => el.remove(), tone === "error" ? 3000 : 1500);
}

function speak(text, lang) {
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang === "fr" ? "fr-FR" : "en-US";
  utter.rate = 0.9;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(text, ok) {
  const el = $("aiStatus");
  el.textContent = text || "";
  if (ok) el.dataset.ok = "1";
  else delete el.dataset.ok;
}

// The one-time language-pack download. background/offscreen.js broadcasts this
// over chrome.runtime.sendMessage, which every extension context receives — the
// same route pdf-viewer/bridge.js uses, since an extension page can't be
// reached by chrome.tabs.sendMessage. Without this the first translation just
// looks hung.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "TRANSLATE_STATUS") return false;
  if (msg.status === "downloading") {
    setStatus(
      "Chrome is downloading the French → English language pack. This happens once, " +
        "and can take a minute — everything after it is instant and offline.",
      false
    );
    if (currentBubble) {
      currentBubble.innerHTML = `<div class="fla-loading">Downloading language pack (one-time)…</div>`;
    }
  }
  return false;
});

// -----------------------------
// Reading aids — the same config the real pages read
// -----------------------------

async function setReadingAids(on) {
  const { config: existing = {} } = await chrome.storage.local.get("config");
  const colorCoding = {
    masculine: "#4a90d9",
    feminine: "#d9498a",
    plural: "#2ea44f",
    neutral: "#888888",
    ...(existing.colorCoding || {}),
    enabled: on,
    categoriesEnabled: { masculine: true, feminine: true, plural: true, neutral: true }
  };
  await chrome.storage.local.set({ config: { ...existing, colorCoding } });
  applyAidClasses(on);
}

// content/annotator.js does exactly this on a real page — the spans are always
// tagged, and a class on <html> decides whether the tags render.
function applyAidClasses(on) {
  const root = document.documentElement;
  root.classList.toggle("fla-colorcoding-on", on);
  root.classList.toggle("fla-cat-masculine-on", on);
  root.classList.toggle("fla-cat-feminine-on", on);
  root.classList.toggle("fla-cat-plural-on", on);
  root.classList.toggle("fla-cat-neutral-on", on);
}

async function syncAidClassesFromConfig() {
  const { config = {} } = await chrome.storage.local.get("config");
  applyAidClasses(!!config.colorCoding?.enabled);
}

// -----------------------------
// Real actions, and the cross-document spotlight
//
// The tutorial's buttons genuinely conjugate, genuinely open the workbook and
// genuinely save — so what the user sees is what the extension does. The catch
// is that the workbook is a DIFFERENT DOCUMENT: lib/tour.js can dim and
// spotlight the page it runs in, and nothing beyond it. So the welcome page
// leaves a note in storage saying what the panel should highlight, and the
// panel runs a one-step spotlight of its own when it sees one. Same scrim, same
// callout, two documents.
// -----------------------------

const TOUR_SPOTLIGHT_KEY = "tourSpotlight";
// Written back by the panel when its relayed spotlight is dismissed — the
// return leg of the same relay. Pressing a bubble button during the tour opens
// the panel, so "Got it" over there is the user finishing this step; without
// this they'd come back to a tour still sitting on the button they already
// pressed, with no way forward but Next.
const TOUR_SPOTLIGHT_DONE_KEY = "tourSpotlightDone";
// Set while the welcome tour is mid-flight; the side panel reads it to know
// not to launch its own tour on top.
const TOUR_RUNNING_KEY = "welcomeTourRunning";

// The `at` of the spotlight we're waiting to hear back about. Matching on it
// means a stale acknowledgement (a panel opened long after the fact) can't
// advance the tour a second time.
let pendingSpotlightAt = 0;

async function spotlightInPanel(spotlight) {
  const at = Date.now();
  pendingSpotlightAt = at;
  await chrome.storage.local.set({ [TOUR_SPOTLIGHT_KEY]: { ...spotlight, at } });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const done = changes[TOUR_SPOTLIGHT_DONE_KEY]?.newValue;
  if (!done || !pendingSpotlightAt || done.at !== pendingSpotlightAt) return;
  pendingSpotlightAt = 0;
  if (isTourActive()) advanceTour();
});

// The word this tutorial saves, and where it puts it. A dedicated bucket, so
// the cleanup at the end of the tour can remove exactly what the tutorial
// added and nothing else.
const TUTORIAL_URL = "collection:tutorial";
let tutorialSave = null; // { url, id } of the entry this run created

async function saveDemoWord(bubble, word, translation, sourceLang, targetLang, contextSentence) {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "SAVE_WORD",
      entry: {
        source: word,
        translation,
        sourceLang,
        targetLang,
        contextSentence,
        url: TUTORIAL_URL
      }
    });
    if (resp?.id) tutorialSave = { url: resp.url || TUTORIAL_URL, id: resp.id };
    await chrome.storage.local.set({
      workbookNames: {
        ...(await chrome.storage.local.get("workbookNames")).workbookNames,
        [TUTORIAL_URL]: "Tutorial"
      }
    });
    await spotlightInPanel({
      target: "#vocabList li:first-child",
      title: "Saved, with its sentence",
      body: `“${word}” is in your workbook now — and so is the sentence you met it in.`
    });
    flash(bubble, "Saved ✓");
  } catch (err) {
    console.error("[FLA welcome] save failed", err);
    flash(bubble, "Save failed", "error");
  }
}

// Conjugation opens the real Conjugation tab, the same path the in-page bubble
// takes on a live site — not an in-page mock of it.
async function requestConjugation(word, bubble) {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "CONJUGATE", verb: word });
  } catch (err) {
    console.error("[FLA welcome] conjugate lookup failed", err);
    flash(bubble, "Lookup failed — try again", "error");
    return;
  }
  if (!resp?.ok) {
    flash(bubble, `“${word}” isn't a verb — try “traverse”`, "error");
    return;
  }
  await spotlightInPanel({
    target: "#conjugationTable",
    title: `${resp.table.infinitive}, in full`,
    body: "Read from the ~7,000 verbs bundled with the extension — no network involved."
  });
  await chrome.runtime.sendMessage({
    type: "OPEN_SIDEPANEL",
    view: "conjugation",
    verb: resp.table.infinitive
  });
}

// Everything the tutorial wrote, removed. The user asked for the buttons to do
// the real thing AND for tutorial words not to litter the workbook; saving for
// real and cleaning up afterwards is the only way to honour both. Scoped hard
// to the one bucket and the one entry this run created.
async function cleanUpTutorialSaves() {
  const { vocab = {}, cards = {}, workbookNames = {} } = await chrome.storage.local.get([
    "vocab",
    "cards",
    "workbookNames"
  ]);
  if (!vocab[TUTORIAL_URL]) return;

  const removedIds = new Set(vocab[TUTORIAL_URL].map((e) => e.id));
  delete vocab[TUTORIAL_URL];
  delete workbookNames[TUTORIAL_URL];

  // Drop this bucket's occurrences from their cards, and the card itself only
  // when nothing else anywhere still points at it.
  for (const [lemma, card] of Object.entries(cards)) {
    card.occurrenceIds = (card.occurrenceIds || []).filter(
      (ref) => !(ref.url === TUTORIAL_URL && removedIds.has(ref.id))
    );
    if (card.occurrenceIds.length === 0) delete cards[lemma];
  }

  tutorialSave = null;
  await chrome.storage.local.set({ vocab, cards, workbookNames });
}

// -----------------------------
// Opening the side panel
// -----------------------------

// sidePanel.open() needs a user gesture; every caller here is inside a click
// handler, which satisfies it.
async function openWorkbook() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.error("[FLA welcome] couldn't open the side panel", err);
    setStatus("Couldn't open the side panel — use the extension popup's “Open workbook”.", false);
  }
}

// There is no chrome.sidePanel.close(). Disabling the panel for this tab is
// what actually shuts it, so this disables and immediately re-enables it —
// the re-enable is in `finally` because leaving it disabled would make the
// workbook unopenable in this tab for the rest of its life.
async function closeWorkbook() {
  let tabId;
  try {
    const tab = await chrome.tabs.getCurrent();
    tabId = tab?.id;
    if (!tabId) return;
    await chrome.sidePanel.setOptions({ tabId, enabled: false });
  } catch (err) {
    console.warn("[FLA welcome] couldn't close the side panel", err);
  } finally {
    if (tabId) {
      await chrome.sidePanel
        .setOptions({ tabId, path: "sidepanel/sidepanel.html", enabled: true })
        .catch((err) => console.error("[FLA welcome] couldn't re-enable the side panel", err));
    }
  }
}

// -----------------------------
// Tours
// -----------------------------


// Every step is anchored to something. A step with no target renders as the
// centred variant — no arrow, a full-screen scrim instead of a cutout — which
// is a visibly different component, and the first and last steps landing on it
// is what made the tour look inconsistent.
const CORE_STEPS = [
  {
    target: ".masthead",
    title: "Bonjour.",
    body: para(
      "L'auxiliaire helps you read <strong>real French</strong> — news, essays, PDFs — " +
        "without leaving the page to look things up.",
      "This takes about a minute. You can skip at any point."
    ),
    placement: "bottom",
    nextLabel: "Show me"
  },
  {
    target: "#toolbarMock",
    title: "Pin it first",
    body: para(
      "Chrome hides new extensions behind the 🧩 puzzle icon. Open that menu and " +
        "pin L'auxiliaire so it's one click away.",
      "This is a drawing of your toolbar — the real one is just above this page."
    ),
    placement: "bottom"
  },
  {
    // The word the rest of the tour uses. Spotlighting it (rather than the whole
    // paragraph and an instruction to pick one) keeps the tour on rails: every
    // later step can rely on the bubble showing this exact verb.
    target: "#demoWordTraverse",
    title: "Click a word",
    body: para(
      "On any French page, <strong>click a word</strong> and its translation appears " +
        "right there. No selecting, no menus.",
      "We'll use “traverse” for the rest of the tour."
    ),
    placement: "bottom",
    padding: 3,
    interactive: true,
    // Going back to this step means going back to before the bubble existed.
    before: () => {
      awaitingTraverseClick = true;
      removeBubble({ immediate: true });
    }
  },
  // The three buttons the bubble offers, one step each, spotlighting the real
  // control rather than describing all three at once.
  //
  // All three pin the bubble to the same word. Re-opening it per step would
  // re-run the translation and rebuild the buttons underneath the spotlight,
  // and stepping Back would land on a target that no longer existed.
  {
    // Workbook comes before Conjugate: the workbook is where both of the other
    // two buttons put their results, so meeting it first means the conjugation
    // table and the saved word land somewhere the user has already seen.
    target: ".fla-bubble .fla-workbook",
    title: "Workbook",
    body: para(
      "Opens your workbook — the side panel where everything you've saved lives, " +
        "grouped into one workbook per page and per PDF.",
      "It's also where conjugation lookup and speaking practice live.",
      "Press it, then <strong>Got it</strong> in the panel to carry on."
    ),
    placement: "bottom",
    padding: 4,
    interactive: true,
    before: () => {
      awaitingTraverseClick = false;
      return ensureDemoBubble("traverse");
    }
  },
  {
    target: ".fla-bubble .fla-conj",
    title: "Conjugate",
    body: para(
      "Opens your workbook's Conjugation tab, with “traverse” already looked up.",
      "Only appears for a real verb — that's what this button is checking."
    ),
    placement: "bottom",
    padding: 4,
    interactive: true,
    before: () => ensureDemoBubble("traverse")
  },
  {
    target: ".fla-bubble .fla-save",
    title: "Save",
    body: para(
      "Saves the word to your workbook — <strong>with the sentence you met it in</strong>, " +
        "never as a bare word on a flashcard.",
      "That context is the thing that makes it stick, so it comes along every time.",
      "That's everything. Bonne lecture."
    ),
    placement: "bottom",
    padding: 4,
    interactive: true,
    before: () => ensureDemoBubble("traverse")
    // No nextLabel override — this is no longer the last step, so the
    // default "Next" is correct; the gate step below is where the tour ends.
  },
  {
    // Centred, not pointing at anything: this is a decision, not a pointer.
    // It's the seam between the page tour and the workbook tour — accepting
    // it hands off to PANEL_TOUR_STEPS (see runCoreTour); declining ends the
    // tour exactly as Skip/Esc/click-away always have. Being the LAST step is
    // what makes that work with no extra plumbing: runTour() resolves
    // completed:true only when Next is pressed here, completed:false for
    // everything else (Not now, Esc, click-away, or bailing out earlier) —
    // one boolean already distinguishes "accepted the gate" from "declined or
    // never got this far", so runCoreTour() branches on it directly.
    target: null,
    title: "One half done",
    body: para(
      "That's the page. Your workbook is the other half — where saved words, " +
        "conjugation and practice live."
    ),
    nextLabel: "Show me the workbook",
    // Ordinarily Skip is hidden on the final step (a last step only ever
    // needs "Done") — this step has two real outcomes, so it needs both.
    showSkip: true,
    skipLabel: "Not now"
  }
];

const CHAPTERS = {
  readingAids: [
    {
      target: "#demoArticle",
      title: "Gender, at a glance",
      body: para(
        "Watch the paragraph: every noun takes a colour by grammatical gender — " +
          "masculine, feminine, or plural.",
        "French gender is the thing that's hardest to absorb from a dictionary and " +
          "easiest to absorb from seeing it, over and over, in real sentences.",
        "It's <strong>off by default</strong>, and it's on now so you can see it."
      ),
      placement: "bottom",
      before: () => setReadingAids(true)
    },
    {
      target: null,
      title: "Left as you found them",
      body: para(
        "Colour coding is switched back off. Turn it on from " +
          "<strong>Settings → reading aids</strong>, in the popup or the side panel, " +
          "where the colours are yours to pick.",
        "It applies live to every open tab — no reloading."
      ),
      before: () => setReadingAids(false)
    }
  ],

  passages: [
    {
      // hideNext + interactive: the step asks for a drag, so it has to wait for
      // one. Offering Next here would invite clicking past the very thing it's
      // asking the user to try.
      target: "#demoArticle",
      title: "Select a whole passage",
      body: para(
        "<strong>Drag across a few words</strong> in the paragraph — a phrase, or one " +
          "sentence.",
        "The whole selection is translated, not just the word you started on."
      ),
      placement: "bottom",
      interactive: true,
      hideNext: true,
      before: () => {
        awaitingPassageSelection = true;
        removeBubble({ immediate: true });
        clearSelection();
      }
    },
    {
      // The whole bubble, so the preview and both buttons are in the cutout
      // together — this step is about the deferred state as a whole, and the
      // two that follow take each button in turn.
      target: ".fla-bubble",
      title: "Long selections wait",
      body: para(
        "Now the whole paragraph is selected. At four lines or sentences the bubble " +
          "shows a <strong>preview</strong> instead of translating straight away.",
        "Selecting that much usually means you want to practise it, not read a wall " +
          "of English."
      ),
      placement: "bottom",
      before: () => {
        awaitingPassageSelection = false;
        return ensureDeferredBubble();
      }
    },
    {
      // Deliberately NOT interactive, here and on the next step. Pressing 🌐
      // swaps the bubble's contents, which detaches this very button — and a
      // cutout measuring a detached element reads all zeros and jumps to the
      // top-left corner. The blocker keeps the button unpressable so the
      // target stays put; the drag in step 1 is this chapter's hands-on part.
      target: ".fla-bubble .fla-translate",
      title: "Translate it anyway",
      body: para(
        "<strong>🌐 Translate</strong> is the way to say yes, translate all of it.",
        "It only exists in this deferred state — once a passage is translated the " +
          "bubble is an ordinary one, with no leftover button."
      ),
      placement: "bottom",
      padding: 4,
      before: () => ensureDeferredBubble()
    },
    {
      target: ".fla-bubble .fla-practice",
      title: "Or practise it aloud",
      body: para(
        "<strong>🎙 Practice</strong> takes the same passage into your workbook and " +
          "runs it as a spoken conversation — it reads one side, you say the other.",
        "That's usually why you selected a whole passage in the first place."
      ),
      placement: "bottom",
      padding: 4,
      before: () => ensureDeferredBubble()
    }
  ],

  conjugation: [
    {
      target: ".fla-bubble .fla-conj",
      title: "Conjugation, offline",
      body: para(
        "“traverse” is a verb, so the bubble offers <strong>Conjugate</strong>.",
        "Press it and your workbook opens on the full table.",
        "You can also type any infinitive straight into the Conjugation tab."
      ),
      placement: "bottom",
      padding: 4,
      interactive: true,
      before: () => ensureDemoBubble("traverse")
    }
  ],

  pdf: [
    {
      target: "#toolbarMockIcon",
      title: "Reading PDFs",
      body: para(
        "Click the L'auxiliaire icon, then <strong>📄 Open a PDF</strong>.",
        "Everything works the same inside it — click a word, drag a passage, save."
      ),
      placement: "bottom",
      padding: 4
    }
  ],

  practice: [
    {
      // Anchored on the card that launched it rather than centred: there's
      // nothing on this page to point at (the mic lives in the side panel),
      // but the card is where the user's eye already is.
      target: '.chapter[data-chapter="practice"]',
      placement: "top",
      title: "Say it out loud",
      body: para(
        "Select a dialogue, choose <strong>🎙 Practice</strong>, and the side panel runs " +
          "it as a conversation: it reads one side, you speak the other.",
        "Scoring is on <em>pronunciation</em>, not spelling — <em>parler</em>, " +
          "<em>parlé</em> and <em>parlez</em> sound identical, and being marked wrong " +
          "for that would be nonsense.",
        "Chrome asks for microphone access once, the first time you start a session."
      )
    }
  ],

  shortcuts: [
    {
      target: '.chapter[data-chapter="shortcuts"]',
      placement: "top",
      title: "Three shortcuts",
      body: para(
        "<kbd>Alt</kbd>+<kbd>T</kbd> — turn hover-to-translate on or off.",
        "<kbd>Alt</kbd>+<kbd>R</kbd> — read the selected text aloud.",
        "<kbd>Alt</kbd>+<kbd>S</kbd> — translate and save the selection in one go. " +
          "(On a long passage, press <strong>🌐 Translate</strong> first — there's " +
          "nothing to save until it's translated.)"
      )
    }
  ]
};

// A pulsing ring around #workbookTour, alongside the hint — a scrim's job is
// "look here", and this does that without owning the screen the way a scrim
// would (see the gate step's comment for why a scrim was ruled out here).
// Independent of showHint()'s own lifecycle (that module has no
// onDismiss hook, and adding one for a single caller isn't worth it), so its
// timeout mirrors the hint's duration and every dismissHint() call site below
// clears it too, for the early-exit paths (a chapter started, the tour
// replayed, the button actually pressed).
let pulseTimer = null;
let pulseTarget = null;

function pulse(selector, duration) {
  stopPulse();
  pulseTarget = document.querySelector(selector);
  if (!pulseTarget) return;
  pulseTarget.classList.add("pulse-ring");
  pulseTimer = setTimeout(stopPulse, duration);
}

function stopPulse() {
  clearTimeout(pulseTimer);
  pulseTimer = null;
  pulseTarget?.classList.remove("pulse-ring");
  pulseTarget = null;
}

// Every dismissHint() call site needs this alongside it, so the ring never
// outlives the hint it's paired with.
function dismissHintAndPulse() {
  dismissHint();
  stopPulse();
}

async function runCoreTour() {
  // The panel checks this before starting its own tour: two tutorials running
  // in two documents at once is nobody's idea of onboarding. Cleared by
  // endTour(), which runs on every exit path.
  await chrome.storage.local.set({ [TOUR_RUNNING_KEY]: Date.now() });
  const { completed } = await runTour({ steps: CORE_STEPS });
  await markTourSeen(TOUR_IDS.welcome, { completed });
  revealChapters();
  $("startTour").hidden = false;
  $("workbookTour").focus();

  if (completed) {
    // The gate step's own Next ("Show me the workbook") is the only way this
    // tour resolves completed:true — Skip/Esc/click-away/bailing out earlier
    // all resolve false. So this branch means exactly one thing: the user
    // asked, right here, to continue into the workbook tour.
    //
    // Fire the request without awaiting it: chrome.sidePanel.open() (inside
    // openWorkbook(), below) needs the click's transient user activation, and
    // awaiting the storage write first crosses a real async boundary that
    // risks losing it. panelTourRequest already has two delivery paths in
    // sidepanel.js (checked at load, and via storage.onChanged), so a request
    // written a beat before the panel finishes opening still lands.
    awaitingPanelTour = true;
    chrome.storage.local.set({ panelTourRequest: Date.now() });
    await endTour();
    openWorkbook();
    return; // finishTutorial() runs when the panel reports back — see below
  }

  await endTour();
  await finishTutorial();
}

// Set while the workbook tour is running in the panel, so a stale
// panelTourDone (one written by a tour the user started themselves, long
// after this page finished) can't trigger the ending twice.
let awaitingPanelTour = false;

// How the tutorial ends, by either route: shut the workbook and hand the user
// to the optional chapters. Closing matters — the panel is a tall pane over
// half the screen, and leaving it open after the tutorial means the thing the
// user is being pointed at is behind it.
async function finishTutorial() {
  await closeWorkbook();
  revealChapters();
  pulse("#chapters", 14000);
  showHint({
    target: "#chapters",
    title: "That's the tour",
    body: para(
      "Everything else is optional — each of these takes about twenty seconds."
    ),
    placement: "top",
    duration: 14000
  });
}

// The workbook tour finished in the other document. Same shape as the
// tourSpotlightDone relay: only act when this page is actually waiting on it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.panelTourDone?.newValue || !awaitingPanelTour) return;
  awaitingPanelTour = false;
  finishTutorial();
});

// Run whenever a tour stops, however it stopped — finished, skipped, or Esc.
// Takes the demo bubble down with it and removes anything the tutorial wrote,
// so nothing it did outlives it.
async function endTour() {
  removeBubble();
  clearSelection();
  pendingSpotlightAt = 0;
  await chrome.storage.local.remove([
    TOUR_SPOTLIGHT_KEY,
    TOUR_SPOTLIGHT_DONE_KEY,
    TOUR_RUNNING_KEY
  ]);
  await cleanUpTutorialSaves();
}

async function runChapter(name) {
  const steps = CHAPTERS[name];
  if (!steps) return;
  dismissHintAndPulse();
  // Chapters spotlight controls they deliberately don't let you press — the
  // passages chapter points at 🌐 Translate and 🎙 Practice to explain them,
  // and pressing either mid-chapter would either swap the bubble out from
  // under the cutout or navigate to the side panel entirely. With the default
  // click-away, reaching for that highlighted button would close the chapter
  // instead, which reads as the tutorial breaking. Skip and Esc still exit.
  await runTour({ steps, dismissOnClickAway: false });
  await endTour();
  await markChapterSeen(name);
  await markChaptersSeenInUi();
}

function revealChapters() {
  const el = $("chapters");
  el.hidden = false;
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function markChaptersSeenInUi() {
  const state = await getTourState();
  const seen = state.chaptersSeen || {};
  document.querySelectorAll(".chapter").forEach((btn) => {
    if (seen[btn.dataset.chapter]) btn.dataset.seen = "1";
    else delete btn.dataset.seen;
  });
}

// -----------------------------
// Boot
// -----------------------------

document.querySelectorAll(".chapter").forEach((btn) => {
  btn.addEventListener("click", () => runChapter(btn.dataset.chapter));
});

$("openWorkbook").addEventListener("click", openWorkbook);

// Opens the panel AND asks it to run its own tour. Requested explicitly, so
// the panel runs it even if it has been seen before.
$("workbookTour").addEventListener("click", async () => {
  dismissHintAndPulse();
  await chrome.storage.local.set({ panelTourRequest: Date.now() });
  await openWorkbook();
});
$("startTour").addEventListener("click", () => {
  dismissHintAndPulse();
  runCoreTour();
});

async function init() {
  // The bubble is styled by content/popup.css, which keys its dark palette off
  // the .fla-theme-* classes content/annotator.js sets on host pages — not off
  // the data-theme attribute lib/theme-mode.js uses. Mirror the resolved theme
  // onto both, or an explicit Light/Dark choice would theme the page chrome and
  // leave the demo bubble behind.
  await initThemeMode((_mode, resolved) => {
    const root = document.documentElement;
    root.classList.toggle("fla-theme-dark", resolved === "dark");
    root.classList.toggle("fla-theme-light", resolved === "light");
  });
  buildDemo();
  await syncAidClassesFromConfig();
  await markChaptersSeenInUi();

  const state = await getTourState();
  if (state.welcomeSeenAt) {
    // Coming back to the page (or replaying) — don't ambush them with the tour.
    revealChapters();
    $("startTour").hidden = false;
  } else {
    runCoreTour();
  }
}

init();
