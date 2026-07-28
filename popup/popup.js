// popup.js

import { putHandoff } from "../lib/pdf-handoff.js";

const $ = (id) => document.getElementById(id);

// Mirrors content/annotator.js's DEFAULT_COLORS — the two are different JS
// worlds with no shared-module path, so this is a deliberate, low-risk
// duplication (four hex strings) rather than a message round-trip just to
// populate default swatch values.
const DEFAULT_COLORS = { masculine: "#4a90d9", feminine: "#d9498a", plural: "#2ea44f", neutral: "#888888" };
// Per-category on/off — separate from DEFAULT_COLORS (which is just hex
// values): lets a user keep, say, plural coloring on while turning masculine/
// feminine off, without losing their chosen colors. Mirrors
// content/annotator.js's DEFAULT_CATEGORIES_ENABLED.
const DEFAULT_CATEGORIES_ENABLED = { masculine: true, feminine: true, plural: true, neutral: true };

async function init() {
  const { config = {} } = await chrome.storage.local.get("config");
  $("hoverToggle").checked = !!config.hoverModeEnabled;
  $("slowSpeech").checked = !!config.slowSpeech;

  const colorCoding = { ...DEFAULT_COLORS, ...(config.colorCoding || {}) };
  const categoriesEnabled = { ...DEFAULT_CATEGORIES_ENABLED, ...(colorCoding.categoriesEnabled || {}) };
  $("colorCodingToggle").checked = !!colorCoding.enabled;
  $("colorMasculine").value = colorCoding.masculine;
  $("colorFeminine").value = colorCoding.feminine;
  $("colorPlural").value = colorCoding.plural;
  $("colorNeutral").value = colorCoding.neutral;
  $("catMasculineToggle").checked = categoriesEnabled.masculine;
  $("catFeminineToggle").checked = categoriesEnabled.feminine;
  $("catPluralToggle").checked = categoriesEnabled.plural;
  $("catNeutralToggle").checked = categoriesEnabled.neutral;
  $("frequencyDimmingToggle").checked = !!config.frequencyDimming;
  $("cognateHighlightingToggle").checked = !!config.cognateHighlighting;

  fetchReadingLevel();
  checkForPdfTab();
}

// Merge rather than replace — config holds fields a given toggle doesn't own
// (defaultSourceLang today, colorCoding and friends in Phase 2), and a
// wholesale overwrite would silently drop them.
async function updateConfig(patch) {
  const { config: existing = {} } = await chrome.storage.local.get("config");
  const config = { ...existing, ...patch };
  await chrome.storage.local.set({ config });
}

$("hoverToggle").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  await updateConfig({ hoverModeEnabled: enabled });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "SET_HOVER_MODE", enabled });
  }
});

$("slowSpeech").addEventListener("change", async (e) => {
  await updateConfig({ slowSpeech: e.target.checked });
});

// Color-coding/dimming/cognate settings apply to every open tab (annotator.js
// reacts via chrome.storage.onChanged), not just the active one — no
// tabs.sendMessage needed here, unlike hover/cursor-follow above.
async function updateColorCoding(patch) {
  const { config: existing = {} } = await chrome.storage.local.get("config");
  const colorCoding = { ...DEFAULT_COLORS, ...(existing.colorCoding || {}), ...patch };
  await updateConfig({ colorCoding });
}

$("colorCodingToggle").addEventListener("change", (e) => updateColorCoding({ enabled: e.target.checked }));
$("colorMasculine").addEventListener("change", (e) => updateColorCoding({ masculine: e.target.value }));
$("colorFeminine").addEventListener("change", (e) => updateColorCoding({ feminine: e.target.value }));
$("colorPlural").addEventListener("change", (e) => updateColorCoding({ plural: e.target.value }));
$("colorNeutral").addEventListener("change", (e) => updateColorCoding({ neutral: e.target.value }));

async function updateCategoryEnabled(category, enabled) {
  const { config: existing = {} } = await chrome.storage.local.get("config");
  const colorCoding = { ...DEFAULT_COLORS, ...(existing.colorCoding || {}) };
  const categoriesEnabled = { ...DEFAULT_CATEGORIES_ENABLED, ...(colorCoding.categoriesEnabled || {}), [category]: enabled };
  await updateColorCoding({ categoriesEnabled });
}

$("catMasculineToggle").addEventListener("change", (e) => updateCategoryEnabled("masculine", e.target.checked));
$("catFeminineToggle").addEventListener("change", (e) => updateCategoryEnabled("feminine", e.target.checked));
$("catPluralToggle").addEventListener("change", (e) => updateCategoryEnabled("plural", e.target.checked));
$("catNeutralToggle").addEventListener("change", (e) => updateCategoryEnabled("neutral", e.target.checked));

$("frequencyDimmingToggle").addEventListener("change", async (e) => {
  await updateConfig({ frequencyDimming: e.target.checked });
});

$("cognateHighlightingToggle").addEventListener("change", async (e) => {
  await updateConfig({ cognateHighlighting: e.target.checked });
});

async function fetchReadingLevel() {
  const label = $("readingLevel");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_LEVEL" });
    label.textContent = resp?.level || (resp?.pending ? "Analyzing…" : "—");
  } catch {
    label.textContent = "—"; // annotator.js not running on this page (e.g. chrome:// tabs)
  }
}

$("openSidepanel").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
});

// -----------------------------
// PDF viewer (Phase 4, manual-open only — see CLAUDE.md/TODO.md for why
// there's no automatic PDF-navigation interception here)
// -----------------------------

function showPdfError(msg) {
  const el = $("pdfError");
  el.textContent = msg;
  el.hidden = false;
}

async function openHandoffInViewer(arrayBuffer, filename) {
  const token = await putHandoff(arrayBuffer, filename);
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`pdf-viewer/viewer.html?handoff=${token}`)
  });
}

$("openPdfFile").addEventListener("click", () => $("pdfFileInput").click());

$("pdfFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // allow picking the same file again later
  if (!file) return;
  $("pdfError").hidden = true;
  const arrayBuffer = await file.arrayBuffer();
  await openHandoffInViewer(arrayBuffer, file.name);
});

// Shown only when the active tab is already a .pdf URL (Chrome's built-in
// viewer keeps the real document URL in the omnibox, so this is a cheap,
// direct check — won't catch PDFs served without a .pdf-suffixed path, e.g.
// /download?id=123, that's a known v1 gap).
async function checkForPdfTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  let isPdf = false;
  try {
    isPdf = new URL(tab.url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    // not a real URL (e.g. a chrome:// internal page) — leave isPdf false
  }
  $("reopenPdf").hidden = !isPdf;
  if (isPdf) $("reopenPdf").dataset.url = tab.url;
}

$("reopenPdf").addEventListener("click", async (e) => {
  $("pdfError").hidden = true;
  const url = e.target.dataset.url;
  try {
    // A cross-origin fetch from the popup's chrome-extension:// origin —
    // only succeeds if the site sends a permissive CORS header, which most
    // publisher/enterprise/Drive-hosted PDFs do not. That's an accepted
    // limitation of staying permission-free (see the Phase 4 plan) — the
    // file picker above always works regardless of the source site.
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const arrayBuffer = await resp.arrayBuffer();
    const filename = decodeURIComponent(url.split("/").pop().split("?")[0]) || "PDF document";
    await openHandoffInViewer(arrayBuffer, filename);
  } catch (err) {
    console.error("[FLA popup] reopen-pdf fetch failed", err);
    showPdfError("Couldn't fetch this PDF (site doesn't allow it) — try downloading it and using the file picker instead.");
  }
});

init();
