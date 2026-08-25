// lib/settings-panel.js
//
// Reading-aid/toggle settings UI, shared between popup.js and sidepanel.js —
// unlike content/annotator.js (a different JS world; content scripts can't
// import extension modules), popup and the side panel are both regular
// extension pages, so this can be a real shared module instead of a
// duplicated copy that drifts out of sync. Both callers must provide the
// same element IDs in their HTML (hoverToggle, slowSpeech, colorCodingToggle,
// colorMasculine/Feminine/Plural/Neutral, catMasculine/Feminine/Plural/
// NeutralToggle, frequencyDimmingToggle, cognateHighlightingToggle,
// readingLevel).

const $ = (id) => document.getElementById(id);

// Mirrors content/annotator.js's DEFAULT_COLORS — that copy stays separate
// since content scripts can't import this module.
export const DEFAULT_COLORS = { masculine: "#4a90d9", feminine: "#d9498a", plural: "#2ea44f", neutral: "#888888" };
// Per-category on/off — separate from DEFAULT_COLORS (which is just hex
// values): lets a user keep, say, plural coloring on while turning masculine/
// feminine off, without losing their chosen colors. Mirrors
// content/annotator.js's DEFAULT_CATEGORIES_ENABLED.
export const DEFAULT_CATEGORIES_ENABLED = { masculine: true, feminine: true, plural: true, neutral: true };

// Merge rather than replace — config holds fields a given toggle doesn't own
// (defaultSourceLang, reviewsPerSession, etc.), and a wholesale overwrite
// would silently drop them.
async function updateConfig(patch) {
  const { config: existing = {} } = await chrome.storage.local.get("config");
  const config = { ...existing, ...patch };
  await chrome.storage.local.set({ config });
}

// Color-coding/dimming/cognate settings apply to every open tab (annotator.js
// reacts via chrome.storage.onChanged), not just the active one — no
// tabs.sendMessage needed here, unlike hover mode below.
async function updateColorCoding(patch) {
  const { config: existing = {} } = await chrome.storage.local.get("config");
  const colorCoding = { ...DEFAULT_COLORS, ...(existing.colorCoding || {}), ...patch };
  await updateConfig({ colorCoding });
}

async function updateCategoryEnabled(category, enabled) {
  const { config: existing = {} } = await chrome.storage.local.get("config");
  const colorCoding = { ...DEFAULT_COLORS, ...(existing.colorCoding || {}) };
  const categoriesEnabled = { ...DEFAULT_CATEGORIES_ENABLED, ...(colorCoding.categoriesEnabled || {}), [category]: enabled };
  await updateColorCoding({ categoriesEnabled });
}

let listenersWired = false;
function wireListeners() {
  if (listenersWired) return; // initSettingsPanel() may be called more than once (e.g. every side-panel tab switch)
  listenersWired = true;

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

  $("colorCodingToggle").addEventListener("change", (e) => updateColorCoding({ enabled: e.target.checked }));
  $("colorMasculine").addEventListener("change", (e) => updateColorCoding({ masculine: e.target.value }));
  $("colorFeminine").addEventListener("change", (e) => updateColorCoding({ feminine: e.target.value }));
  $("colorPlural").addEventListener("change", (e) => updateColorCoding({ plural: e.target.value }));
  $("colorNeutral").addEventListener("change", (e) => updateColorCoding({ neutral: e.target.value }));

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
}

export async function initSettingsPanel() {
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

  wireListeners();
}

// Reading level depends on the active tab, which can change while the side
// panel stays open (unlike the popup, which is re-created fresh every open)
// — kept separate from initSettingsPanel() so callers can re-fetch it on
// every tab switch without re-wiring listeners.
export async function refreshReadingLevel() {
  const label = $("readingLevel");
  if (!label) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_LEVEL" });
    label.textContent = resp?.level || (resp?.pending ? "Analyzing…" : "—");
  } catch {
    label.textContent = "—"; // annotator.js not running on this page (e.g. chrome:// tabs)
  }
}
