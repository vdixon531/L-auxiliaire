// popup.js

const $ = (id) => document.getElementById(id);

async function init() {
  const { hoverModeEnabled = false, cursorFollowMode = true, config = {} } =
    await chrome.storage.local.get(["hoverModeEnabled", "cursorFollowMode", "config"]);
  $("hoverToggle").checked = hoverModeEnabled;
  $("cursorFollowToggle").checked = cursorFollowMode;
  $("slowSpeech").checked = !!config.slowSpeech;
}

$("hoverToggle").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  await chrome.storage.local.set({ hoverModeEnabled: enabled });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "SET_HOVER_MODE", enabled });
  }
});

$("cursorFollowToggle").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  await chrome.storage.local.set({ cursorFollowMode: enabled });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "SET_CURSOR_MODE", enabled });
  }
});

$("slowSpeech").addEventListener("change", async (e) => {
  // Merge rather than replace — config holds fields this toggle doesn't own
  // (defaultSourceLang today, colorCoding and friends in Phase 2), and a
  // wholesale overwrite would silently drop them.
  const { config: existing = {} } = await chrome.storage.local.get("config");
  await chrome.storage.local.set({
    config: { ...existing, slowSpeech: e.target.checked }
  });
});

$("openSidepanel").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
});

init();
