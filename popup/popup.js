// popup.js

import { putHandoff } from "../lib/pdf-handoff.js";
import { initSettingsPanel, refreshReadingLevel } from "../lib/settings-panel.js";

const $ = (id) => document.getElementById(id);

async function init() {
  await initSettingsPanel();
  refreshReadingLevel();
  checkForPdfTab();
  checkForSelection();
}

// -----------------------------
// Practice the page's selected text
// -----------------------------

// The popup can't read the page, so it asks whatever is running in the tab.
// Regular pages have content-script.js (reachable with tabs.sendMessage);
// the PDF viewer is an extension page, where bridge.js listens on the
// runtime broadcast instead — both answer the same GET_SELECTION message.
async function getTabSelection(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "GET_SELECTION" });
    if (resp?.text) return resp.text;
  } catch {
    // No content script in this tab (extension page, chrome://, the web
    // store) — fall through to the broadcast.
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_SELECTION" });
    return resp?.text || "";
  } catch {
    return "";
  }
}

let pendingSelection = "";

async function checkForSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  pendingSelection = await getTabSelection(tab.id);
  const btn = $("practiceSelection");
  const hint = $("practiceSelectionHint");
  btn.disabled = !pendingSelection;
  hint.textContent = pendingSelection
    ? `“${pendingSelection.slice(0, 60)}${pendingSelection.length > 60 ? "…" : ""}”`
    : "Select a passage on the page first.";
}

$("practiceSelection").addEventListener("click", async () => {
  if (!pendingSelection) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  // Same handoff the content-script bubble's 🎙 Practice button uses — the
  // intent is written first so a panel opening fresh finds it in checkIntent(),
  // and an already-open one picks it up via storage.onChanged.
  await chrome.storage.local.set({
    sidepanelIntent: { view: "practice", text: pendingSelection, at: Date.now() }
  });
  await chrome.sidePanel.open({ tabId: tab.id });
  window.close();
});

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
  // Mozilla's own vendored PDF.js viewer (pdf-viewer/vendor/web/viewer.html),
  // not a custom page — see CLAUDE.md for why.
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`pdf-viewer/vendor/web/viewer.html?handoff=${token}`)
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
