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
  ["."]
];

const CONTEXT_SENTENCE =
  "Le petit déjeuner est prêt sur la table de la terrasse.";


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
  grandes: "large, big"
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
    span.addEventListener("click", () => showBubbleFor(span, { fromUser: true }));
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
function placeBubble(bubble, anchor) {
  const r = anchor.getBoundingClientRect();
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

  let translation = null;
  let sourceLang = "fr";
  let targetLang = "en";

  try {
    const resp = await chrome.runtime.sendMessage({
      type: "TRANSLATE",
      text: word,
      contextSentence: CONTEXT_SENTENCE
    });
    if (resp?.error) throw new Error(resp.error);
    translation = resp?.translation ?? null;
    sourceLang = resp?.sourceLang || "fr";
    targetLang = resp?.targetLang || "en";
  } catch (err) {
    console.warn("[FLA welcome] live translation unavailable, using fallback", err);
  }

  if (bubble !== currentBubble) return; // superseded by a later click

  let note = "";
  if (!translation) {
    translation = FALLBACK_GLOSS[word.toLowerCase()] || "—";
    note = "Showing a built-in gloss — on-device translation isn't available here yet.";
  }

  renderBubble(bubble, span, { word, translation, sourceLang, targetLang });
  setStatus(note, false);
}

function renderBubble(bubble, anchor, { word, translation, sourceLang, targetLang }) {
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

  bubble.querySelector('[data-action="save"]').onclick = () => saveDemoWord(bubble, word, translation, sourceLang, targetLang);

  placeBubble(bubble, anchor);
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
// Set while the welcome tour is mid-flight; the side panel reads it to know
// not to launch its own tour on top.
const TOUR_RUNNING_KEY = "welcomeTourRunning";

async function spotlightInPanel(spotlight) {
  await chrome.storage.local.set({
    [TOUR_SPOTLIGHT_KEY]: { ...spotlight, at: Date.now() }
  });
}

// The word this tutorial saves, and where it puts it. A dedicated bucket, so
// the cleanup at the end of the tour can remove exactly what the tutorial
// added and nothing else.
const TUTORIAL_URL = "collection:tutorial";
let tutorialSave = null; // { url, id } of the entry this run created

async function saveDemoWord(bubble, word, translation, sourceLang, targetLang) {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "SAVE_WORD",
      entry: {
        source: word,
        translation,
        sourceLang,
        targetLang,
        contextSentence: CONTEXT_SENTENCE,
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
      "We'll use <em>traverse</em> for the rest of the tour."
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
    target: ".fla-bubble .fla-conj",
    title: "Conjugate",
    body: para(
      "When the word is a verb, this looks up its full conjugation.",
      "About 7,000 French verbs are bundled with the extension, so the table opens " +
        "instantly and works with no network at all.",
      "In normal use it opens in your workbook's Conjugation tab."
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
    target: ".fla-bubble .fla-workbook",
    title: "Workbook",
    body: para(
      "Opens your workbook — the side panel where everything you've saved lives, " +
        "grouped into one workbook per page and per PDF.",
      "It's also where conjugation lookup and speaking practice live."
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
    before: () => ensureDemoBubble("traverse"),
    nextLabel: "Finish"
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
      target: "#demoArticle",
      title: "Select a whole passage",
      body: para(
        "Drag across a phrase or a paragraph and you get the whole thing translated, " +
          "not just one word.",
        "Long selections are the exception: at four lines or more the bubble shows a " +
          "preview and a <strong>🌐 Translate</strong> button instead of translating " +
          "straight away — usually you selected that much to practise it, not to read " +
          "a wall of English."
      ),
      placement: "bottom"
    }
  ],

  conjugation: [
    {
      target: ".fla-bubble .fla-conj",
      title: "Conjugation, offline",
      body: para(
        "<em>traverse</em> is a verb, so the bubble offers <strong>Conjugate</strong>.",
        "Press it: your workbook opens on the full table, read from the ~7,000 verbs " +
          "bundled with the extension. No network involved.",
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
      target: null,
      title: "Reading PDFs",
      body: para(
        "Open the popup and choose <strong>📄 Open a PDF</strong> to read one with the " +
          "same click-to-translate and save tools.",
        "You open PDFs by hand on purpose: automatically intercepting every PDF you " +
          "click would mean asking for far broader permissions than this extension wants.",
        "A PDF's words are filed by the document's content, so the same file keeps one " +
          "workbook no matter where you opened it from."
      )
    }
  ],

  practice: [
    {
      target: null,
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
      target: null,
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

async function runCoreTour() {
  // The panel checks this before starting its own tour: two tutorials running
  // in two documents at once is nobody's idea of onboarding. Cleared by
  // endTour(), which runs on every exit path.
  await chrome.storage.local.set({ [TOUR_RUNNING_KEY]: Date.now() });
  const { completed } = await runTour({ steps: CORE_STEPS });
  await closeWorkbook();
  await endTour();
  await markTourSeen(TOUR_IDS.welcome, { completed });
  revealChapters();
  $("startTour").hidden = false;
  // The workbook is the half of the product the page can't show, so point at
  // it rather than leaving the user on a finished tour with nowhere to go.
  $("afterTourPrompt").hidden = false;
  $("workbookTour").focus();
}

// Run whenever a tour stops, however it stopped — finished, skipped, or Esc.
// Takes the demo bubble down with it and removes anything the tutorial wrote,
// so nothing it did outlives it.
async function endTour() {
  removeBubble();
  await chrome.storage.local.remove([TOUR_SPOTLIGHT_KEY, TOUR_RUNNING_KEY]);
  await cleanUpTutorialSaves();
}

async function runChapter(name) {
  const steps = CHAPTERS[name];
  if (!steps) return;
  await runTour({ steps });
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
  await chrome.storage.local.set({ panelTourRequest: Date.now() });
  await openWorkbook();
});
$("startTour").addEventListener("click", runCoreTour);

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
