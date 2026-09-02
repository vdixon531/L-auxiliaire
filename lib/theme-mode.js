// lib/theme-mode.js
//
// Light/dark preference, shared by every regular extension page (popup, side
// panel, mic-grant). Same shape as settings-panel.js: an exported init with an
// idempotent listener guard, since the side panel can call it more than once
// per document lifetime.
//
// Stored as `config.themeMode`; absent means "system", so an existing install
// keeps behaving exactly as it did before this setting existed.
//
// Applied by stamping `data-theme` on <html>, which lib/theme.css keys off. The
// in-page bubble can't use that file (it's on a host page, not ours), so
// content/annotator.js mirrors this onto the host's <html> as
// `.fla-theme-dark`/`.fla-theme-light` from the same config value.

export const THEME_MODES = ["system", "light", "dark"];

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)");

/** The mode as stored — one of THEME_MODES. */
export async function getThemeMode() {
  const { config = {} } = await chrome.storage.local.get("config");
  return THEME_MODES.includes(config.themeMode) ? config.themeMode : "system";
}

/** What's actually on screen right now: "light" or "dark", never "system". */
export function resolveTheme(mode) {
  if (mode === "light" || mode === "dark") return mode;
  return prefersDark().matches ? "dark" : "light";
}

/** Stamp the root element. "system" removes the attribute so the media query
 *  in lib/theme.css takes back over. */
export function applyThemeMode(mode) {
  const root = document.documentElement;
  if (mode === "light" || mode === "dark") root.dataset.theme = mode;
  else delete root.dataset.theme;
}

export async function setThemeMode(mode) {
  if (!THEME_MODES.includes(mode)) return;
  // Merge rather than replace — config holds fields this setting doesn't own.
  const { config: existing = {} } = await chrome.storage.local.get("config");
  await chrome.storage.local.set({ config: { ...existing, themeMode: mode } });
  applyThemeMode(mode); // don't wait for the storage event to round-trip
}

/** Flip to the opposite of what's currently *rendered*, and make it explicit.
 *  From "system" that means committing to the opposite of the OS setting,
 *  which is what a user clicking a sun/moon button is asking for. */
export async function toggleThemeMode() {
  const next = resolveTheme(await getThemeMode()) === "dark" ? "light" : "dark";
  await setThemeMode(next);
  return next;
}

let wired = false;

/** Apply the stored mode and keep it applied. Call once per page; safe to
 *  call again. `onChange(mode, resolved)` fires on every change, including the
 *  initial apply, so a caller can keep an icon in sync. */
export async function initThemeMode(onChange) {
  const mode = await getThemeMode();
  applyThemeMode(mode);
  onChange?.(mode, resolveTheme(mode));

  if (wired) return mode;
  wired = true;

  // Another surface (the popup, or the panel's own settings tab) may have
  // changed it while this page is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.config) return;
    const next = changes.config.newValue?.themeMode;
    const m = THEME_MODES.includes(next) ? next : "system";
    applyThemeMode(m);
    onChange?.(m, resolveTheme(m));
  });

  // On "system", the OS can flip underneath us — the attribute doesn't change
  // but the resolved theme does, and a sun/moon icon has to follow it.
  prefersDark().addEventListener("change", async () => {
    const m = await getThemeMode();
    if (m === "system") onChange?.(m, resolveTheme(m));
  });

  return mode;
}

/** Sun when dark is showing (click for light), moon when light is showing.
 *  Inline SVG rather than an emoji: it inherits currentColor, so it sits in
 *  the type hierarchy instead of dropping a colour picture into it. */
export function themeIcon(resolved) {
  return resolved === "dark"
    ? `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
         <circle cx="12" cy="12" r="4.2"/>
         <path d="M12 2.4v2.3M12 19.3v2.3M4.2 12H1.9M22.1 12h-2.3M6.5 6.5 4.9 4.9M19.1 19.1l-1.6-1.6M17.5 6.5l1.6-1.6M4.9 19.1l1.6-1.6"/>
       </svg>`
    : `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z"/>
       </svg>`;
}
