// pages/pages.js
//
// The only script the static information pages need: follow the user's
// light/dark choice, exactly as every other extension surface does. No page
// logic — the FAQ's open/closed state is the browser's own <details>.
import { initThemeMode } from "../lib/theme-mode.js";

initThemeMode();
