// lib/extension-enabled.js
//
// The master on/off switch: `config.extensionEnabled`. Shared by the three
// contexts that can import a module — the service worker (keyboard command +
// toolbar badge), lib/settings-panel.js (the toggle in the popup and the side
// panel's Settings tab). The two content scripts re-read the same key
// themselves, since a content script can't import extension modules (the same
// reason content/annotator.js keeps its own DEFAULT_COLORS copy).
//
// What "off" means is deliberately narrow: the extension stops touching HOST
// PAGES — no bubble, no click/hover translate, no word wrapping, no reading
// aids — which is the whole point of the switch (regular browsing shouldn't
// have a French tutor on top of it). Surfaces the user opened on purpose keep
// working: the popup, the workbook side panel, the PDF viewer and the welcome
// page are all deliberate acts, not interruptions, and a switch that broke
// them would be an uninstall rather than a pause.
//
// ABSENT MEANS ON. Every reader must test `!== false`, never truthiness: the
// key doesn't exist until the user flips the switch for the first time, and a
// truthy test would ship the extension switched off.

const STORAGE_KEY_CONFIG = "config";

export function isExtensionEnabled(config = {}) {
  return config?.extensionEnabled !== false;
}

export async function readExtensionEnabled() {
  const { [STORAGE_KEY_CONFIG]: config = {} } = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
  return isExtensionEnabled(config);
}

// Merge, never replace — config holds everything from targetLang to
// colorCoding, and a wholesale write would silently drop it all.
export async function setExtensionEnabled(enabled) {
  const { [STORAGE_KEY_CONFIG]: existing = {} } = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
  await chrome.storage.local.set({
    [STORAGE_KEY_CONFIG]: { ...existing, extensionEnabled: !!enabled }
  });
  return !!enabled;
}

export async function toggleExtensionEnabled() {
  return setExtensionEnabled(!(await readExtensionEnabled()));
}
