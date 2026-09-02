// popup.js

import { putHandoff } from "../lib/pdf-handoff.js";
import { initSettingsPanel, refreshReadingLevel, watchReadingLevel } from "../lib/settings-panel.js";
import { initThemeMode } from "../lib/theme-mode.js";

const $ = (id) => document.getElementById(id);

async function init() {
  await initThemeMode();
  await initSettingsPanel();
  refreshReadingLevel();
  // The popup is short-lived, but a page still finishing its first scan will
  // push a level while it's open.
  watchReadingLevel();
  checkForPdfTab();
}

$("openSidepanel").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
  // The popup has done its job — leaving it floating over the panel it just
  // opened is only in the way.
  window.close();
});

// chrome:// URLs can't be linked to from a page, but an extension page is
// allowed to open one in a tab.
$("editShortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
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
  // The empty `file=` matters. viewer.mjs does:
  //     file = params.get("file") ?? AppOptions.get("defaultUrl");
  // and ?? only falls through on null/undefined — so an empty-string `file`
  // stops it ever reading defaultUrl, whose stock value is a sample PDF we
  // deliberately didn't vendor. An empty file then fails validateFileURL's
  // falsy guard harmlessly and `if (file)` skips the open entirely, so the
  // viewer waits for our own open() with no stray request. Setting the option
  // from bridge.js is a race against run()'s first await; this is not.
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`pdf-viewer/vendor/web/viewer.html?file=&handoff=${token}`)
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
