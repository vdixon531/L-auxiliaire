// sidepanel.js

import {
  initSettingsPanel,
  refreshReadingLevel,
  watchReadingLevel,
  DEFAULT_COLORS
} from "../lib/settings-panel.js";
import { initThemeMode, toggleThemeMode, themeIcon } from "../lib/theme-mode.js";
import {
  TOUR_IDS,
  runTour,
  shouldRunTour,
  markTourSeen,
  getTourState,
  para
} from "../lib/tour.js";
import { chevron, setFlipped } from "../lib/flip.js";
import { initPracticePanel, startPracticeFromText, pausePractice } from "../lib/practice-panel.js";

const $ = (id) => document.getElementById(id);

// -----------------------------
// Appearance — the rail's sun/moon button is a shortcut for the Settings
// tab's Appearance control; both write the same config.themeMode, and
// initThemeMode()'s storage listener keeps this icon right no matter which
// one (or which other surface) did the writing.
// -----------------------------

initThemeMode((mode, resolved) => {
  const icon = $("themeToggleIcon");
  if (!icon) return;
  icon.innerHTML = themeIcon(resolved);
  // Icon only — it sits over the content, so it has to stay out of the way.
  // The title carries what the label used to say.
  $("themeToggle").title =
    mode === "system"
      ? `Following your system (${resolved}) — click to set ${resolved === "dark" ? "light" : "dark"}`
      : `${resolved[0].toUpperCase()}${resolved.slice(1)} — click to switch`;
});

$("themeToggle").addEventListener("click", () => toggleThemeMode());

// -----------------------------
// Tabs
// -----------------------------

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

let currentView = "vocab";

function switchView(view) {
  // A live practice turn shouldn't keep talking/listening under another tab.
  if (currentView === "practice" && view !== "practice") pausePractice();
  currentView = view;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === view));
  if (view === "vocab") {
    renderWorkbookSidebar();
    renderVocab();
  }
  if (view === "practice") {
    initPracticePanel();
  }
  if (view === "settings") {
    initSettingsPanel();
    refreshReadingLevel();
    // The panel outlives tab switches and navigations, so the readout has to
    // follow them rather than answering once on the way in.
    watchReadingLevel();
  }
}

// -----------------------------
// Workbooks — each vocab[url] bucket (a regular page's URL, or a PDF's
// "pdf:<hash>" content-hash key) is its own workbook. `null` selection means
// "All Words", the flattened view across every workbook.
// -----------------------------

let selectedWorkbook = null;

function labelForWorkbook(url, entries) {
  const latest = entries[entries.length - 1]; // most recently saved — same "latest wins" convention cards use
  if (url.startsWith("collection:")) return "Untitled collection";
  if (url.startsWith("pdf:")) return latest?.pdfTitle || "PDF document";
  if (latest?.pageTitle) return latest.pageTitle;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function renderWorkbookSidebar() {
  const { vocab = {}, workbookNames = {}, workbookOrder = [] } = await chrome.storage.local.get([
    "vocab",
    "workbookNames",
    "workbookOrder"
  ]);

  // The selected workbook may have just been deleted, or emptied by deleting
  // its last entry — fall back to "All" rather than keeping a dead selection.
  if (selectedWorkbook && !vocab[selectedWorkbook]) selectedWorkbook = null;

  // Counts distinct words, matching what selecting All Words actually shows.
  const totalCount = allWordsEntries(vocab).length;
  const items = [
    `<div class="workbook-item ${selectedWorkbook === null ? "active" : ""}" data-key="">
      <span class="workbook-name">All Words</span>
      <span class="workbook-count">${totalCount}</span>
    </div>`,
    ...orderedWorkbooks(vocab, workbookOrder).map(([url, entries]) => {
      const label = workbookNames[url] || labelForWorkbook(url, entries);
      return `
        <div class="workbook-item ${selectedWorkbook === url ? "active" : ""}" data-key="${escapeAttr(url)}">
          <span class="workbook-drag" aria-hidden="true" title="Drag to reorder"></span>
          <span class="workbook-name" title="${escapeAttr(label)}">${escapeHtml(label)}</span>
          <span class="workbook-count">${entries.length}</span>
        </div>
      `;
    })
  ];
  $("workbookList").innerHTML = items.join("");

  $("workbookList").querySelectorAll(".workbook-item").forEach((el) => {
    el.addEventListener("click", () => {
      selectedWorkbook = el.dataset.key || null;
      renderWorkbookSidebar();
      renderVocab($("vocabSearch").value);
    });
    if (el.dataset.key) {
      el.addEventListener("contextmenu", (e) => openWorkbookMenu(e, el.dataset.key));
      wireDrag(el);
    }
  });
}

// Stored order wins; anything not in it (a workbook created since, or one saved
// from a page) keeps its natural position after the ordered ones. sort() is
// stable, so those hold their relative order.
function orderedWorkbooks(vocab, order) {
  const rank = (key) => {
    const i = order.indexOf(key);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return Object.entries(vocab).sort(([a], [b]) => rank(a) - rank(b));
}

async function saveWorkbookOrder(keys) {
  await chrome.storage.local.set({ workbookOrder: keys });
}

function updateWorkbookHeader(vocab, workbookNames) {
  const header = $("workbookHeader");
  if (!selectedWorkbook) {
    header.hidden = true;
    return;
  }
  header.hidden = false;
  const entries = vocab[selectedWorkbook] || [];
  $("workbookTitle").textContent = workbookNames[selectedWorkbook] || labelForWorkbook(selectedWorkbook, entries);
}

async function deleteWorkbook(url) {
  const { vocab = {}, cards = {}, workbookNames = {} } =
    await chrome.storage.local.get(["vocab", "cards", "workbookNames"]);

  const entryIds = new Set((vocab[url] || []).map((e) => e.id));
  delete vocab[url];

  // Strip this workbook's occurrences out of every card; a card left with no
  // occurrences anywhere else shouldn't keep coming up for review either.
  for (const [lemma, card] of Object.entries(cards)) {
    card.occurrenceIds = card.occurrenceIds.filter((ref) => !(ref.url === url && entryIds.has(ref.id)));
    if (card.occurrenceIds.length === 0) delete cards[lemma];
  }

  delete workbookNames[url];

  // A deleted workbook must not keep a slot in the drag order.
  const { workbookOrder = [] } = await chrome.storage.local.get("workbookOrder");
  const order = workbookOrder.filter((k) => k !== url);

  await chrome.storage.local.set({ vocab, cards, workbookNames, workbookOrder: order });
}

// -----------------------------
// Right-click a workbook
//
// Rename and delete already exist as buttons in the workbook header, but that
// header only appears once a workbook is selected — and reaching for a row you
// can see is the more natural gesture. Both entry points call the same two
// functions.
// -----------------------------

let menuTargetKey = null;

function openWorkbookMenu(e, key) {
  e.preventDefault();
  menuTargetKey = key;
  const menu = $("workbookMenu");
  menu.hidden = false;
  // Measure after unhiding, then keep it inside the panel.
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  menu.style.left = `${Math.min(e.clientX, Math.max(4, vw - w - 4))}px`;
  menu.style.top = `${Math.min(e.clientY, Math.max(4, vh - h - 4))}px`;
}

function closeWorkbookMenu() {
  $("workbookMenu").hidden = true;
  menuTargetKey = null;
}

document.addEventListener("click", (e) => {
  if (!$("workbookMenu").hidden && !e.target.closest("#workbookMenu")) closeWorkbookMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeWorkbookMenu();
});
document.addEventListener("scroll", closeWorkbookMenu, { capture: true, passive: true });

$("workbookMenu").addEventListener("click", async (e) => {
  const action = e.target.closest("button")?.dataset.action;
  const key = menuTargetKey;
  closeWorkbookMenu();
  if (!action || !key) return;
  if (action === "rename") await renameWorkbookByKey(key);
  if (action === "delete") await removeWorkbookByKey(key);
});

async function renameWorkbookByKey(key) {
  const { vocab = {}, workbookNames = {} } = await chrome.storage.local.get(["vocab", "workbookNames"]);
  const current = workbookNames[key] || labelForWorkbook(key, vocab[key] || []);
  const next = prompt("Rename this workbook:", current);
  if (next == null || !next.trim()) return;
  workbookNames[key] = next.trim();
  await chrome.storage.local.set({ workbookNames });
  await renderWorkbookSidebar();
  await renderVocab($("vocabSearch").value);
}

async function removeWorkbookByKey(key) {
  const { vocab = {}, workbookNames = {} } = await chrome.storage.local.get(["vocab", "workbookNames"]);
  const entries = vocab[key] || [];
  const label = workbookNames[key] || labelForWorkbook(key, entries);
  if (!confirm(`Delete the entire "${label}" workbook? This removes all ${entries.length} saved word(s) in it and can't be undone.`)) {
    return;
  }
  await deleteWorkbook(key);
  if (selectedWorkbook === key) selectedWorkbook = null;
  await renderWorkbookSidebar();
  await renderVocab($("vocabSearch").value);
}

// -----------------------------
// Drag to reorder
//
// Pointer events rather than HTML5 drag-and-drop: native DnD gives you a
// translucent ghost and nothing else, so the row you're moving doesn't follow
// the cursor and the rows around it don't get out of the way. Here the dragged
// row is transformed under the pointer and its neighbours slide by exactly its
// height, which is what makes the order legible while you're still holding it.
// -----------------------------

let drag = null;

function wireDrag(el) {
  const handle = el.querySelector(".workbook-drag");
  handle?.addEventListener("pointerdown", (e) => startDrag(e, el));
}

function startDrag(e, el) {
  if (e.button !== 0) return;
  e.preventDefault();

  const list = $("workbookList");
  const rows = [...list.querySelectorAll(".workbook-item")].filter((r) => r.dataset.key);
  const index = rows.indexOf(el);
  if (index === -1) return;

  // Measured once, up front: every row is about to be transformed, and
  // getBoundingClientRect() reflects transforms.
  const rects = rows.map((r) => r.getBoundingClientRect());

  drag = {
    el,
    rows,
    rects,
    index,
    target: index,
    startY: e.clientY,
    step: rects[index].height + 1, // + the 1px flex gap between rows
    moved: false
  };

  el.classList.add("is-dragging");
  list.classList.add("is-reordering");
  el.setPointerCapture(e.pointerId);
  el.addEventListener("pointermove", onDragMove);
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
}

function onDragMove(e) {
  if (!drag) return;
  const dy = e.clientY - drag.startY;
  if (Math.abs(dy) > 3) drag.moved = true;
  drag.el.style.transform = `translateY(${dy}px)`;

  // Land where the dragged row's centre has passed a neighbour's centre.
  const centre = drag.rects[drag.index].top + drag.rects[drag.index].height / 2 + dy;
  let target = drag.index;
  for (let i = drag.index - 1; i >= 0; i--) {
    const mid = drag.rects[i].top + drag.rects[i].height / 2;
    if (centre < mid) target = i;
    else break;
  }
  for (let i = drag.index + 1; i < drag.rows.length; i++) {
    const mid = drag.rects[i].top + drag.rects[i].height / 2;
    if (centre > mid) target = i;
    else break;
  }
  if (target === drag.target) return;
  drag.target = target;

  drag.rows.forEach((row, i) => {
    if (i === drag.index) return;
    let shift = 0;
    if (target > drag.index && i > drag.index && i <= target) shift = -drag.step;
    if (target < drag.index && i < drag.index && i >= target) shift = drag.step;
    row.style.transform = shift ? `translateY(${shift}px)` : "";
  });
}

async function endDrag(e) {
  if (!drag) return;
  const { el, rows, index, target, moved } = drag;
  drag = null;

  el.releasePointerCapture?.(e.pointerId);
  el.removeEventListener("pointermove", onDragMove);
  el.removeEventListener("pointerup", endDrag);
  el.removeEventListener("pointercancel", endDrag);
  el.classList.remove("is-dragging");
  $("workbookList").classList.remove("is-reordering");
  rows.forEach((r) => (r.style.transform = ""));

  if (!moved) return;

  // A drag can end with a click on the row underneath; swallow that one, or
  // letting go would also change the selection. Cancelling pointerdown often
  // suppresses that click already, so this must not stay armed waiting for a
  // click that never comes — clearing it on the next tick covers both cases.
  const swallowClick = (ev) => ev.stopPropagation();
  document.addEventListener("click", swallowClick, { capture: true, once: true });
  setTimeout(() => document.removeEventListener("click", swallowClick, { capture: true }), 0);

  if (target === index) return;

  // Rebuilt from what's on screen so workbooks with no stored rank get one
  // too — otherwise the next render would scatter them again.
  const keys = rows.map((r) => r.dataset.key);
  const [moving] = keys.splice(index, 1);
  keys.splice(target, 0, moving);

  await saveWorkbookOrder(keys);
  await renderWorkbookSidebar();
}

$("renameWorkbook").addEventListener("click", () => {
  if (selectedWorkbook) renameWorkbookByKey(selectedWorkbook);
});

$("deleteWorkbook").addEventListener("click", () => {
  if (selectedWorkbook) removeWorkbookByKey(selectedWorkbook);
});

// -----------------------------
// Vocab list
// -----------------------------

// "All Words" is one row per distinct word, not one per saved occurrence.
// A word deliberately kept in two collections is still one word, and seeing it
// twice in the flattened view reads as a bug. The newest occurrence wins, so
// the row carries the most recent translation and context.
//
// Per-workbook views are NOT deduped this way — they can't be, since a bucket
// already holds at most one entry per card (see saveWord in service-worker.js).
function allWordsEntries(vocab) {
  const byCard = new Map();
  for (const entry of Object.values(vocab).flat()) {
    // Pre-cards entries (or a phrase that resolved to nothing) have no cardId;
    // fall back to the surface form so they still collapse sensibly.
    const key = entry.cardId || entry.source?.toLowerCase();
    const seen = byCard.get(key);
    if (!seen || (entry.savedAt || 0) > (seen.savedAt || 0)) byCard.set(key, entry);
  }
  return [...byCard.values()].sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
}

async function renderVocab(filter = "") {
  const { vocab = {}, workbookNames = {} } = await chrome.storage.local.get(["vocab", "workbookNames"]);
  updateWorkbookHeader(vocab, workbookNames);

  const sourceEntries = selectedWorkbook ? vocab[selectedWorkbook] || [] : allWordsEntries(vocab);
  const list = $("vocabList");
  list.innerHTML = "";
  const filtered = filter
    ? sourceEntries.filter(
        (v) =>
          v.source.toLowerCase().includes(filter.toLowerCase()) ||
          v.translation.toLowerCase().includes(filter.toLowerCase())
      )
    : sourceEntries;

  if (filtered.length === 0) {
    list.innerHTML = `<li class="empty">No saved words yet.</li>`;
    return;
  }

  filtered
    .slice()
    .reverse()
    .forEach((entry) => {
      const li = document.createElement("li");
      // Two faces on one card: the saved word, and its conjugation on the back.
      // The back is built on first flip, not here — one CONJUGATE round-trip per
      // card up front would be a lot of work for tables most cards never show.
      li.innerHTML = `
        <div class="entry-flip" data-id="${escapeAttr(entry.id)}" data-source="${escapeAttr(entry.source)}">
          <div class="entry-faces">
            <div class="entry entry--front">
              <div class="entry-source">
                <span class="lang">${entry.sourceLang}</span>
                <span class="entry-word ${genderClass(entry)}">${escapeHtml(entry.source)}</span>
                ${genderChip(entry)}
                <button class="speak" data-text="${escapeAttr(entry.source)}" data-lang="${entry.sourceLang}">▶</button>
              </div>
              <div class="entry-translation">
                <span class="lang">${entry.targetLang}</span>
                ${escapeHtml(entry.translation)}
                <button class="speak" data-text="${escapeAttr(entry.translation)}" data-lang="${entry.targetLang}">▶</button>
              </div>
              ${entry.contextSentence ? `<div class="entry-context">${escapeHtml(entry.contextSentence)}</div>` : ""}
              ${entry.url?.startsWith("pdf:") ? `<div class="entry-origin">📄 ${escapeHtml(entry.pdfTitle || "PDF document")}</div>` : ""}
              <button class="delete" data-id="${entry.id}" data-url="${escapeAttr(entry.url || "")}">×</button>
              <span class="entry-flip-hint" aria-hidden="true">${chevron()}</span>
            </div>
            <div class="entry entry--back" aria-hidden="true"></div>
          </div>
        </div>
      `;
      li.querySelector(".entry--front").addEventListener("click", (e) => {
        // The row's own controls aren't a flip gesture.
        if (e.target.closest("button")) return;
        flipCard(li.querySelector(".entry-flip"), entry);
      });
      li.querySelector(".entry--back").addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        unflipCard(li.querySelector(".entry-flip"));
      });
      list.appendChild(li);
    });

  list.querySelectorAll(".speak").forEach((b) =>
    b.addEventListener("click", () => speak(b.dataset.text, b.dataset.lang))
  );
  list.querySelectorAll(".delete").forEach((b) =>
    b.addEventListener("click", () => deleteEntry(b.dataset.url, b.dataset.id))
  );
}

async function deleteEntry(url, id) {
  const { vocab = {}, cards = {} } = await chrome.storage.local.get(["vocab", "cards"]);
  const bucket = url || "unknown";
  const removed = vocab[bucket]?.find((v) => v.id === id);
  if (vocab[bucket]) {
    vocab[bucket] = vocab[bucket].filter((v) => v.id !== id);
    // A page/PDF workbook exists only because something was saved from it, so
    // an empty one is meaningless. A hand-made collection is the opposite: the
    // user created it on purpose, and it has to survive being emptied — only
    // deleteWorkbook() removes one.
    if (vocab[bucket].length === 0 && !isCollection(bucket)) delete vocab[bucket];
  }

  // Drop this occurrence's pointer from its card; if that was the card's
  // last occurrence, the word isn't saved anywhere anymore, so it shouldn't
  // keep coming up for review either.
  const card = removed && cards[removed.cardId];
  if (card) {
    card.occurrenceIds = card.occurrenceIds.filter((ref) => !(ref.url === bucket && ref.id === id));
    if (card.occurrenceIds.length === 0) delete cards[removed.cardId];
  }

  await chrome.storage.local.set({ vocab, cards });
  await renderWorkbookSidebar();
  renderVocab($("vocabSearch").value);
}

$("vocabSearch").addEventListener("input", (e) => renderVocab(e.target.value));

// -----------------------------
// Exports
// -----------------------------

// One Export button opening a format menu, rather than a button per format
// crowding a toolbar that also has to hold search. Reuses the .ctx-menu
// component the workbook right-click already uses, so this panel has one
// popup-menu look rather than two.

async function exportCsv() {
  const { vocab = {} } = await chrome.storage.local.get("vocab");
  const entries = allWordsEntries(vocab);
  const rows = [["source", "sourceLang", "translation", "targetLang", "contextSentence", "savedAt", "url"]];
  entries.forEach((v) =>
    rows.push([v.source, v.sourceLang, v.translation, v.targetLang, v.contextSentence || "", new Date(v.savedAt).toISOString(), v.url || ""])
  );
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  downloadBlob(csv, "vocab.csv", "text/csv");
}

function closeExportMenu() {
  $("exportMenu").hidden = true;
  $("exportBtn").setAttribute("aria-expanded", "false");
}

function openExportMenu() {
  const menu = $("exportMenu");
  const btn = $("exportBtn");
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");

  // Anchored under the button and clamped into the panel, which is narrow
  // enough that a menu hung from the button's left edge would overflow it.
  const r = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const w = menu.offsetWidth;
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(4, Math.min(r.left, vw - w - 4))}px`;
  menu.querySelector("button")?.focus();
}

$("exportBtn").addEventListener("click", (e) => {
  e.stopPropagation(); // otherwise the document listener closes it immediately
  if ($("exportMenu").hidden) openExportMenu();
  else closeExportMenu();
});

$("exportMenu").addEventListener("click", (e) => {
  const format = e.target.closest("button")?.dataset.format;
  if (!format) return;
  closeExportMenu();
  if (format === "csv") exportCsv();
  if (format === "anki") exportAnki();
});

document.addEventListener("click", (e) => {
  if (!$("exportMenu").hidden && !e.target.closest("#exportMenu, #exportBtn")) closeExportMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeExportMenu();
});
document.addEventListener("scroll", closeExportMenu, { capture: true, passive: true });

async function exportAnki() {
  // Anki accepts tab-separated import files.
  const { vocab = {} } = await chrome.storage.local.get("vocab");
  const entries = allWordsEntries(vocab);
  const tsv = entries
    .map((v) => `${csvEscape(v.source)}\t${csvEscape(v.translation)}\t${csvEscape(v.contextSentence || "")}`)
    .join("\n");
  downloadBlob(tsv, "vocab-anki.txt", "text/plain");
}

function csvEscape(s) {
  const str = String(s ?? "");
  return /[",\n\t]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadBlob(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}


// -----------------------------
// Hand-made collections
//
// A collection is an ordinary vocab bucket keyed "collection:<uuid>" instead of
// a page URL — the same trick pdf-viewer/bridge.js plays with "pdf:<hash>".
// lib/normalize-url.js passes both through untouched (a non-special scheme with
// no hostname or trailing slash to normalise), so cards, search, export, rename
// and delete all work on them with no special-casing.
// -----------------------------

const COLLECTION_PREFIX = "collection:";

function isCollection(key) {
  return typeof key === "string" && key.startsWith(COLLECTION_PREFIX);
}

async function createCollection(name) {
  const key = `${COLLECTION_PREFIX}${crypto.randomUUID()}`;
  const { vocab = {}, workbookNames = {} } = await chrome.storage.local.get([
    "vocab",
    "workbookNames"
  ]);
  vocab[key] = [];
  workbookNames[key] = name;
  await chrome.storage.local.set({ vocab, workbookNames });
  return key;
}

// Matches renameWorkbook()'s use of prompt(). Wrapped because a blocked
// prompt() would otherwise make this button do nothing at all — better to
// create the collection under a default name the ✎ button can fix.
function askCollectionName() {
  try {
    const name = prompt("Name this collection", "My words");
    return name === null ? null : name.trim() || "My words";
  } catch {
    return "New collection";
  }
}

$("newCollection").addEventListener("click", async () => {
  const name = askCollectionName();
  if (name === null) return;
  selectedWorkbook = await createCollection(name);
  await renderWorkbookSidebar();
  renderVocab($("vocabSearch").value);
});

// -----------------------------
// Add a word by typing it
//
// Saving from a page is the main path, but it can't be the only one — you can
// hear a word, or want one you already know the meaning of, without having a
// page to select it on.
// -----------------------------

function setAddWordError(msg) {
  const el = $("addWordError");
  el.textContent = msg || "";
  el.hidden = !msg;
}

async function populateDestinations() {
  const { vocab = {}, workbookNames = {} } = await chrome.storage.local.get([
    "vocab",
    "workbookNames"
  ]);
  const select = $("addWordDest");
  const keys = Object.keys(vocab);
  // Collections first — they're the likely destination for a typed word.
  keys.sort((a, b) => Number(isCollection(b)) - Number(isCollection(a)));

  select.replaceChildren();
  for (const key of keys) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = workbookNames[key] || labelForWorkbook(key, vocab[key] || []);
    select.appendChild(opt);
  }
  const create = document.createElement("option");
  create.value = "__new__";
  create.textContent = "New collection…";
  select.appendChild(create);

  // Default to whatever the user is looking at; otherwise the first collection,
  // otherwise offer to make one.
  if (selectedWorkbook && vocab[selectedWorkbook]) select.value = selectedWorkbook;
  else select.value = keys.find(isCollection) || "__new__";
}

function openAddWord() {
  setAddWordError("");
  $("addWordForm").hidden = false;
  populateDestinations();
  $("addWordSource").focus();
}

function closeAddWord() {
  $("addWordForm").hidden = true;
  $("addWordForm").reset();
  setAddWordError("");
}

$("addWordBtn").addEventListener("click", () => {
  if ($("addWordForm").hidden) openAddWord();
  else closeAddWord();
});

$("addWordCancel").addEventListener("click", closeAddWord);

$("addWordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const source = $("addWordSource").value.trim();
  if (!source) return;

  const submit = $("addWordSubmit");
  submit.disabled = true;
  setAddWordError("");

  try {
    let dest = $("addWordDest").value;
    if (dest === "__new__") {
      const name = askCollectionName();
      if (name === null) return;
      dest = await createCollection(name);
    }

    let translation = $("addWordTranslation").value.trim();
    let sourceLang = "fr";
    let targetLang = "en";

    // Only translate when the user didn't supply one. The response's own
    // sourceLang is what decides the direction, so typing an English word to
    // learn its French works exactly as well as the other way round.
    if (!translation) {
      const resp = await chrome.runtime.sendMessage({
        type: "TRANSLATE",
        text: source,
        contextSentence: $("addWordContext").value.trim() || source
      });
      if (resp?.error) throw new Error(resp.error);
      translation = resp?.translation || "";
      sourceLang = resp?.sourceLang || sourceLang;
      targetLang = resp?.targetLang || targetLang;
    }

    if (!translation) {
      setAddWordError("Couldn't translate that — type a translation and try again.");
      return;
    }

    const resp = await chrome.runtime.sendMessage({
      type: "SAVE_WORD",
      entry: {
        source,
        translation,
        sourceLang,
        targetLang,
        contextSentence: $("addWordContext").value.trim() || source,
        // Explicit url, so SAVE_WORD files it here instead of falling back to
        // the sending tab's address (which would be the side panel's own).
        url: dest
      }
    });

    // Typing in a word this collection already holds refreshes it rather than
    // adding a second row. Say so and keep the form open — silently closing on
    // what looks like a no-op reads as the form having failed.
    if (resp?.duplicate) {
      setAddWordError(`“${source}” is already in this collection — updated it.`);
      selectedWorkbook = dest;
      return;
    }

    selectedWorkbook = dest;
    closeAddWord();
    // No render here: handleVocabChange() owns "a word was added" and will
    // re-render, select the destination and play the arrival animation.
    // Rendering here too would race it and drop the animation.
  } catch (err) {
    console.error("[FLA sidepanel] add word failed", err);
    setAddWordError(err?.message || "Couldn't save that word.");
  } finally {
    submit.disabled = false;
  }
});


// -----------------------------
// A word arriving from somewhere else
//
// Saving happens in the page, the PDF viewer or the conjugation tab — never in
// the list that has to show it. Until now nothing here watched `vocab`, so a
// save left the panel showing stale content, and the only feedback was a count
// that changed the next time something happened to re-render the rail.
//
// storage.onChanged hands over both the old and new value, so the added entry
// can be identified exactly rather than inferred from a timestamp.
// -----------------------------

const ARRIVAL_MS = 1800;

function findAddedEntry(oldVocab = {}, newVocab = {}) {
  let newest = null;
  for (const [url, entries] of Object.entries(newVocab || {})) {
    const before = new Set(((oldVocab || {})[url] || []).map((e) => e.id));
    for (const entry of entries) {
      if (before.has(entry.id)) continue;
      if (!newest || (entry.savedAt || 0) >= (newest.savedAt || 0)) {
        newest = { url, id: entry.id, savedAt: entry.savedAt, source: entry.source };
      }
    }
  }
  return newest;
}

async function handleVocabChange(oldVocab, newVocab) {
  const added = findAddedEntry(oldVocab, newVocab);

  // A deletion, or a change made from this panel's own delete button: keep the
  // rail's counts honest and stop there.
  if (!added) {
    await renderWorkbookSidebar();
    if (currentView === "vocab") await renderVocab($("vocabSearch").value);
    return;
  }

  // Don't drag someone out of the Conjugation or Practice tab to show them a
  // card. The rail is still refreshed so the counts are right when they return,
  // and switchView() re-renders the list on the way back in.
  if (currentView !== "vocab") {
    await renderWorkbookSidebar();
    return;
  }

  // Open the workbook it landed in, so the card is actually on screen.
  selectedWorkbook = added.url;

  // A stale filter would hide the very thing being announced. Only clear it
  // when it would — an unrelated search stays put.
  const filter = $("vocabSearch").value;
  if (filter && !matchesFilter(newVocab[added.url]?.find((e) => e.id === added.id), filter)) {
    $("vocabSearch").value = "";
  }

  await renderWorkbookSidebar();
  await renderVocab($("vocabSearch").value);
  announceEntry(added.id);
}

function matchesFilter(entry, filter) {
  if (!entry) return false;
  const f = filter.toLowerCase();
  return (
    entry.source.toLowerCase().includes(f) || entry.translation.toLowerCase().includes(f)
  );
}

// Scroll it into view and play the arrival animation. Entries render newest
// first, so this is normally already at the top — "if needed" is exactly what
// block: "nearest" means.
function announceEntry(id) {
  const card = $("vocabList")?.querySelector(`.entry-flip[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  card.classList.add("is-new");
  setTimeout(() => card.classList.remove("is-new"), ARRIVAL_MS);
}

// -----------------------------
// Gender on the card front
//
// Same rule content/annotator.js uses on a page: nouns only, and plural wins
// over gender. Everything else gets nothing rather than a misleading label.
//
// The mark is a line STYLE as well as a colour — solid for masculine, dotted
// for feminine, dashed for plural — because the gender colours are
// user-chosen and can't be relied on to carry contrast, and colour alone
// excludes anyone who can't separate the two hues. The word's own ink is
// untouched, so the underline is decoration and the text stays at full
// contrast.
// -----------------------------

function genderOf(entry) {
  if (!entry || entry.pos !== "NOM") return null;
  if (entry.plural || entry.number === "p") return "plural";
  if (entry.gender === "m") return "masculine";
  if (entry.gender === "f") return "feminine";
  return null; // known noun, unknown gender — say nothing rather than guess
}

function genderClass(entry) {
  const g = genderOf(entry);
  return g ? `entry-word--${g}` : "";
}

const GENDER_LABEL = { masculine: "m.", feminine: "f.", plural: "pl." };

function genderChip(entry) {
  const g = genderOf(entry);
  if (!g) return "";
  // The same phrasing the back of the card uses, so the two agree.
  const title = describeWord(entry) || g;
  return `<span class="gender gender--${g}" title="${escapeAttr(title)}">${GENDER_LABEL[g]}</span>`;
}

// The gender colours are a user setting (config.colorCoding), shared with the
// in-page reading aids — so the workbook marks a word the same colour the page
// does. Mirrored onto the panel root the way annotator.js mirrors them onto a
// host page.
function applyGenderColors(config = {}) {
  const colors = { ...DEFAULT_COLORS, ...(config.colorCoding || {}) };
  const root = document.documentElement;
  root.style.setProperty("--fla-color-masculine", colors.masculine);
  root.style.setProperty("--fla-color-feminine", colors.feminine);
  root.style.setProperty("--fla-color-plural", colors.plural);
  root.style.setProperty("--fla-color-neutral", colors.neutral);
}

// -----------------------------
// Card flip — a saved word on the front, its conjugation on the back
//
// The back face is absolutely positioned, so the container's natural height is
// the front's. Flipping therefore has to set an explicit height, or a taller
// conjugation table would be clipped by a card sized for two lines of text.
// -----------------------------

const conjugationCache = new Map();

async function conjugationFor(word) {
  if (conjugationCache.has(word)) return conjugationCache.get(word);
  let table = null;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "CONJUGATE", verb: word });
    table = resp?.ok ? resp.table : null;
  } catch (err) {
    console.warn("[FLA sidepanel] conjugation lookup failed", err);
  }
  conjugationCache.set(word, table);
  return table;
}

function describeWord(entry) {
  const bits = [];
  const pos = {
    NOM: "noun", VER: "verb", ADJ: "adjective", ADV: "adverb",
    PRE: "preposition", CON: "conjunction", PRO: "pronoun", ART: "article"
  }[entry.pos] || entry.pos;
  if (pos) bits.push(pos);
  if (entry.gender === "m") bits.push("masculine");
  if (entry.gender === "f") bits.push("feminine");
  if (entry.plural) bits.push("plural");
  return bits.join(" · ");
}

function renderBackFace(back, entry, table) {
  back.replaceChildren();

  const head = document.createElement("div");
  head.className = "entry-back__head";
  const title = document.createElement("span");
  title.className = "entry-back__word";
  title.textContent = table ? table.infinitive : entry.source;
  const close = document.createElement("button");
  close.className = "entry-back__close";
  close.type = "button";
  close.innerHTML = chevron("left");
  close.title = "Back to the word";
  head.append(title, close);
  back.appendChild(head);

  if (table) {
    // Two tenses: the card is ~340px wide, and the full table belongs in the
    // Conjugation tab.
    const wanted = ["présent", "passé composé"];
    const tenses = Object.entries(table.tenses || {}).filter(([n]) => wanted.includes(n));
    for (const [name, forms] of tenses.length ? tenses : Object.entries(table.tenses || {}).slice(0, 1)) {
      const block = document.createElement("div");
      block.className = "tense";
      const h = document.createElement("h3");
      h.textContent = name;
      block.appendChild(h);
      const tbl = document.createElement("table");
      forms.slice(0, 6).forEach((form, i) => {
        const tr = document.createElement("tr");
        const p = document.createElement("td");
        p.className = "pronoun";
        p.textContent = PRONOUNS[i] || "";
        const f = document.createElement("td");
        f.textContent = form;
        tr.append(p, f);
        tbl.appendChild(tr);
      });
      block.appendChild(tbl);
      back.appendChild(block);
    }
    const more = document.createElement("button");
    more.className = "entry-back__more";
    more.type = "button";
    more.textContent = "All tenses →";
    more.addEventListener("click", () => {
      switchView("conjugation");
      $("verbInput").value = table.infinitive;
      lookupVerb(table.infinitive);
    });
    back.appendChild(more);
  } else {
    // Not a verb — say so, and show what is known rather than an empty card.
    const desc = describeWord(entry);
    const p = document.createElement("p");
    p.className = "entry-back__note";
    p.textContent = desc
      ? `${desc} — no conjugation, this isn't a verb.`
      : "No conjugation — this isn't a verb.";
    back.appendChild(p);
    if (entry.contextSentence) {
      const ctx = document.createElement("div");
      ctx.className = "entry-context";
      ctx.textContent = entry.contextSentence;
      back.appendChild(ctx);
    }
  }

  close.addEventListener("click", () => unflipCard(back.closest(".entry-flip")));
}

async function flipCard(flip, entry) {
  if (!flip || flip.classList.contains("is-flipped")) return;
  const back = flip.querySelector(".entry--back");

  if (!flip.dataset.loaded) {
    back.replaceChildren(Object.assign(document.createElement("p"), {
      className: "entry-back__note",
      textContent: "Looking up…"
    }));
    // Flip immediately — waiting on the lookup before moving makes the card
    // feel unresponsive; the back fills in behind the animation.
    setFlipped(flip, true);
    const table = await conjugationFor(entry.source);
    renderBackFace(back, entry, table);
    flip.dataset.loaded = "1";
    // Re-measure: the placeholder was shorter than the real table.
    if (flip.classList.contains("is-flipped")) setFlipped(flip, true);
    return;
  }

  setFlipped(flip, true);
}

function unflipCard(flip) {
  setFlipped(flip, false);
}

// -----------------------------
// Conjugation
// -----------------------------

$("lookupVerb").addEventListener("click", () => lookupVerb($("verbInput").value.trim()));
$("verbInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") lookupVerb(e.target.value.trim());
});

async function lookupVerb(verb) {
  if (!verb) return;
  const container = $("conjugationTable");
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "CONJUGATE", verb });
  } catch (err) {
    // Message channel itself failed (e.g. the service worker was asleep and
    // didn't wake in time, or the extension was reloaded mid-session) — a
    // different failure than "not a verb," but just as silent to the user
    // if we don't say something here.
    console.error("[FLA sidepanel] conjugate lookup failed", err);
    container.innerHTML = `<div class="error">Lookup failed — try again.</div>`;
    return;
  }
  if (!resp?.table) {
    container.innerHTML = `<div class="error">${escapeHtml(resp?.error || `Not a known verb: ${verb}`)}</div>`;
    return;
  }
  container.innerHTML = renderConjugationTable(resp.table);
  container.querySelectorAll(".speak").forEach((b) =>
    b.addEventListener("click", () => speak(b.dataset.text, "fr"))
  );
  container.querySelector(".save-verb")?.addEventListener("click", (e) => saveVerbTable(resp.table, e.currentTarget));
}

const PRONOUNS = ["je", "tu", "il/elle", "nous", "vous", "ils/elles"];
const IMPERATIF_LABELS = ["tu", "nous", "vous"];
const PARTICIPE_PASSE_LABELS = ["m. sg.", "m. pl.", "f. sg.", "f. pl."];

function labelsForTense(tense) {
  if (tense === "impératif") return IMPERATIF_LABELS;
  if (tense === "participe passé") return PARTICIPE_PASSE_LABELS;
  if (tense === "participe présent") return [""];
  return PRONOUNS;
}

function renderConjugationTable(table) {
  const tenseHtml = Object.entries(table.tenses || {})
    .map(([tense, forms]) => {
      const labels = labelsForTense(tense);
      const rows = forms
        .map((form, i) => `
          <tr>
            <td class="pronoun">${labels[i] || ""}</td>
            <td>${escapeHtml(form)}</td>
            <td><button class="speak" data-text="${escapeAttr((labels[i] || "") + " " + form)}">▶</button></td>
          </tr>
        `)
        .join("");
      return `
        <div class="tense">
          <h3>${escapeHtml(tense)}</h3>
          <table>${rows}</table>
        </div>
      `;
    })
    .join("");
  return `
    <div class="verb-header">
      <h2>${escapeHtml(table.infinitive)}</h2>
      <button class="save-verb">＋ Save to workbook</button>
    </div>
    ${tenseHtml}
  `;
}

// Where a word goes when the user didn't pick a workbook: whatever they're
// looking at, else their first hand-made collection, else a new one. A save
// with nowhere obvious to land shouldn't silently invent a page-shaped bucket.
async function defaultSaveDestination() {
  const { vocab = {} } = await chrome.storage.local.get("vocab");
  if (selectedWorkbook && vocab[selectedWorkbook]) return selectedWorkbook;
  const existing = Object.keys(vocab).find(isCollection);
  if (existing) return existing;
  return createCollection("My words");
}

// SAVE_VERB alone looked like it worked and wasn't: it writes the table to
// storage.verbs, which NOTHING in the UI reads — so the button said "Saved ✓"
// and the verb never appeared in a workbook. The visible save is a vocab
// entry, the same one the bubble's ＋ Save makes; SAVE_VERB is still sent
// alongside it because the full table is genuinely different data from the
// one-line entry, and the schema keeps a place for it.
async function saveVerbTable(table, button) {
  const original = button?.textContent;
  try {
    if (button) {
      button.textContent = "Saving…";
      button.disabled = true;
    }

    const infinitive = table.infinitive;
    let translation = "";
    let sourceLang = "fr";
    let targetLang = "en";
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "TRANSLATE",
        text: infinitive,
        contextSentence: infinitive
      });
      if (!resp?.error) {
        translation = resp?.translation || "";
        sourceLang = resp?.sourceLang || sourceLang;
        targetLang = resp?.targetLang || targetLang;
      }
    } catch (err) {
      console.warn("[FLA sidepanel] verb translation unavailable", err);
    }

    const url = await defaultSaveDestination();
    await chrome.runtime.sendMessage({
      type: "SAVE_WORD",
      entry: {
        source: infinitive,
        // A verb with no translation is still worth saving — the conjugation
        // is the point — so fall back rather than refusing.
        translation: translation || "(verb)",
        sourceLang,
        targetLang,
        contextSentence: infinitive,
        pos: "VER",
        url
      }
    });
    await chrome.runtime.sendMessage({ type: "SAVE_VERB", table });
    // handleVocabChange() re-renders and announces the new card; see above.

    if (button) button.textContent = "Saved ✓";
  } catch (err) {
    console.error("[FLA sidepanel] save-verb failed", err);
    if (button) {
      button.textContent = "Save failed — try again";
      button.disabled = false;
    }
  } finally {
    if (button) {
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 1500);
    }
  }
}

// -----------------------------
// TTS
// -----------------------------

// Kept fresh by the storage.onChanged listener below — speak() itself stays
// sync, so it can't await the config read per call.
let slowSpeechEnabled = false;
chrome.storage.local.get("config").then(({ config = {} }) => {
  slowSpeechEnabled = !!config.slowSpeech;
});

function speak(text, langCode) {
  const lang = langCode === "en" ? "en-US" : "fr-FR";
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  utter.rate = slowSpeechEnabled ? 0.7 : 0.9;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

// -----------------------------
// Helpers
// -----------------------------

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// -----------------------------
// Intent handoff from content script
// -----------------------------

// The load path (checkIntent) and the storage.onChanged path below can both
// see the same freshly-written intent — dedupe by its `at` timestamp.
let lastIntentAt = 0;

async function handleIntent(intent) {
  if (!intent) return;
  await chrome.storage.local.remove("sidepanelIntent");
  // Only act on recent intents, once
  if (Date.now() - intent.at > 5000) return;
  if (intent.at === lastIntentAt) return;
  lastIntentAt = intent.at;
  if (intent.view === "conjugation" && intent.verb) {
    switchView("conjugation");
    $("verbInput").value = intent.verb;
    lookupVerb(intent.verb);
  }
  if (intent.view === "practice" && intent.text) {
    switchView("practice");
    startPracticeFromText(intent.text);
  }
}

async function checkIntent() {
  const { sidepanelIntent } = await chrome.storage.local.get("sidepanelIntent");
  await handleIntent(sidepanelIntent);
}

// checkIntent() only runs at load — a panel that's already open when the user
// clicks a bubble button needs to see the new intent land too. (The remove()
// inside handleIntent re-fires this with newValue undefined, hence the guard.)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.vocab) handleVocabChange(changes.vocab.oldValue, changes.vocab.newValue);
  if (changes.sidepanelIntent?.newValue) handleIntent(changes.sidepanelIntent.newValue);
  if (changes.config?.newValue) {
    slowSpeechEnabled = !!changes.config.newValue.slowSpeech;
    applyGenderColors(changes.config.newValue);
  }
});

// -----------------------------
// First-open tour
// -----------------------------

// Runs once, the first time the panel is ever opened. Every step's copy has to
// work with an empty workbook, because on a genuine first run that's exactly
// what's here — runTour() centres a step whose target has no box rather than
// throwing, so an absent #vocabList entry degrades instead of breaking.
// One idea per step. The tabs used to be a single card describing all four at
// once, which is more than anyone reads standing at a doorway.
const PANEL_TOUR_STEPS = [
  {
    target: '.tab[data-view="vocab"]',
    title: "Vocabulary",
    body: para("Everything you've saved, grouped into workbooks."),
    placement: "bottom"
  },
  {
    target: '.tab[data-view="conjugation"]',
    title: "Conjugation",
    body: para("Any of ~7,000 French verbs, in full, offline."),
    placement: "bottom"
  },
  {
    target: '.tab[data-view="practice"]',
    title: "Practice",
    body: para(
      "Runs a dialogue out loud and scores how you say it.",
      "The gear beside it holds every setting."
    ),
    placement: "bottom"
  },
  {
    // The first row, not the whole rail: a full-height target leaves the
    // callout nowhere to sit but over it.
    target: "#workbookList .workbook-item",
    title: "One workbook per page",
    body: para(
      "Words file themselves by where you found them — a workbook per article and " +
        "per PDF, plus All Words across everything.",
      "Right-click any workbook to rename or delete it, or drag it to reorder."
    ),
    placement: "bottom"
  },
  {
    // Matches the first entry, or the "No saved words yet" row when empty.
    target: "#vocabList li:first-child",
    title: "Word, meaning, sentence",
    body: para(
      "Each entry keeps the sentence you met the word in, so you revise it in " +
        "context rather than as a bare pair.",
      "<strong>▶</strong> &nbsp;reads it aloud",
      "<strong>›</strong> &nbsp;flips the card to its conjugation",
      "<strong>×</strong> &nbsp;removes it"
    ),
    placement: "bottom"
  },
  {
    target: "#exportBtn",
    title: "Take it with you",
    body: para(
      "Search across every workbook, or hit <strong>Export</strong> for a CSV " +
        "spreadsheet or an Anki deck.",
      "Nothing is locked in here."
    ),
    placement: "bottom"
  }
];

// -----------------------------
// Spotlight relayed from the welcome page
//
// The tutorial's bubble buttons do the real thing, which means the result of
// pressing one lands HERE — a different document. lib/tour.js can only dim the
// page it runs in, so the welcome page writes what it wants highlighted to
// storage and this picks it up: same scrim, same callout, the user's eye led
// from the button they pressed to the thing that changed.
// -----------------------------

const TOUR_SPOTLIGHT_KEY = "tourSpotlight";
const SPOTLIGHT_FRESH_MS = 10000;
let lastSpotlightAt = 0;

async function runRelayedSpotlight(spotlight) {
  if (!spotlight?.target) return;
  // Stale notes (a panel opened long after the tour moved on) and repeats of
  // one already shown are both no-ops. Same shape as handleIntent's guards.
  if (Date.now() - (spotlight.at || 0) > SPOTLIGHT_FRESH_MS) return;
  if (spotlight.at === lastSpotlightAt) return;
  lastSpotlightAt = spotlight.at;

  await chrome.storage.local.remove(TOUR_SPOTLIGHT_KEY);
  // Let the view it points at finish rendering before measuring it.
  await new Promise((r) => setTimeout(r, 250));
  await runTour({
    steps: [
      {
        target: spotlight.target,
        title: spotlight.title,
        body: para(spotlight.body),
        placement: "auto",
        nextLabel: "Got it"
      }
    ]
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[TOUR_SPOTLIGHT_KEY]?.newValue) runRelayedSpotlight(changes[TOUR_SPOTLIGHT_KEY].newValue);
  // "Tour the workbook" pressed while this panel is already open.
  if (changes[PANEL_TOUR_REQUEST_KEY]?.newValue) checkPanelTourRequest();
});

async function checkSpotlight() {
  const { [TOUR_SPOTLIGHT_KEY]: spotlight } = await chrome.storage.local.get(TOUR_SPOTLIGHT_KEY);
  await runRelayedSpotlight(spotlight);
}

const PANEL_TOUR_REQUEST_KEY = "panelTourRequest";

// The welcome page's "Tour the workbook" button. An explicit request runs the
// tour whether or not it has been seen — unlike the first-open path below.
async function checkPanelTourRequest() {
  const { [PANEL_TOUR_REQUEST_KEY]: at } = await chrome.storage.local.get(PANEL_TOUR_REQUEST_KEY);
  if (!at || Date.now() - at > 10000) return false;
  await chrome.storage.local.remove(PANEL_TOUR_REQUEST_KEY);
  await runPanelTour();
  return true;
}

async function runPanelTour() {
  switchView("vocab");
  const { completed } = await runTour({ steps: PANEL_TOUR_STEPS });
  await markTourSeen(TOUR_IDS.panel, { completed });
}

async function maybeRunPanelTour() {
  if (!(await shouldRunTour(TOUR_IDS.panel))) return;

  // Never start on top of the welcome tour, and never as a surprise on the way
  // out of one. The welcome page's bubble buttons open this panel mid-tour, so
  // dismissing the little relayed spotlight used to drop the user straight into
  // a second, longer tutorial they never asked for. The workbook tour is now
  // something you choose — from "Tour the workbook" on the welcome page, or by
  // opening the panel on your own later.
  const { welcomeTourRunning } = await chrome.storage.local.get("welcomeTourRunning");
  if (welcomeTourRunning) return;

  const state = await getTourState();
  if (state.welcomeOpenedAt && !state.welcomeSeenAt) return;

  switchView("vocab");
  const { completed } = await runTour({ steps: PANEL_TOUR_STEPS });
  await markTourSeen(TOUR_IDS.panel, { completed });
}

// Await the first render before the tour measures anything: an unrendered
// #vocabList has zero height, which runTour() reads as "no target" and centres.
(async () => {
  const { config = {} } = await chrome.storage.local.get("config");
  applyGenderColors(config);
  await renderWorkbookSidebar();
  await renderVocab();
  checkIntent();
  // Order matters: an explicit "Tour the workbook" beats everything; failing
  // that, a spotlight relayed mid-tour from the welcome page; and only if
  // neither applies does the panel consider its own first-open tour.
  if (!(await checkPanelTourRequest())) {
    await checkSpotlight();
    maybeRunPanelTour();
  }
})();
