// service-worker.js
// Handles: translation orchestration (actual API calls happen in the
// offscreen document), vocab storage, conjugation lookups, side panel
// orchestration, keyboard commands.

import { conjugate, isKnownVerb } from "./conjugation.js";
import { getCachedTranslation, setCachedTranslation, ensureCacheEvictionAlarm } from "./cache.js";
import { detectLang } from "./detect-lang.js";
import { normalizeUrl } from "../lib/normalize-url.js";

const STORAGE_KEY_VOCAB = "vocab";
const STORAGE_KEY_CONFIG = "config";

// -----------------------------
// Config (target lang, defaults)
// -----------------------------

async function getConfig() {
  const { config } = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
  return (
    config || {
      targetLang: "en", // when source is FR, translate to EN, and vice versa
      defaultSourceLang: "fr" // used when detection is ambiguous
    }
  );
}

// -----------------------------
// On-device translation (via offscreen document)
// -----------------------------
//
// Translator.* only works in a window context, not the service worker, so
// the actual API calls happen in offscreen.js — see that file for why.

const OFFSCREEN_URL = "background/offscreen.html";
let creatingOffscreen = null; // in-flight createDocument() promise, to dedupe concurrent callers

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (existing.length > 0) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["DOM_SCRAPING"],
        justification:
          "Chrome's built-in Translator API requires a window/document context and is unavailable in the service worker."
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function translate(text, contextSentence = "", tabId) {
  const cfg = await getConfig();

  // The surrounding sentence is a far better language signal than a lone
  // word, which is why the content script sends it along with TRANSLATE.
  const sourceLang = detectLang(text, contextSentence, cfg.defaultSourceLang || "fr");
  const targetLang = sourceLang === "fr" ? "en" : "fr";

  const cached = await getCachedTranslation(text, sourceLang, targetLang);
  if (cached != null) {
    return { source: text, translation: cached, sourceLang, targetLang };
  }

  await ensureOffscreenDocument();
  const resp = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_TRANSLATE",
    text,
    sourceLang,
    targetLang,
    tabId
  });
  if (!resp?.ok) {
    throw new Error(resp?.error || "Translation failed");
  }

  await setCachedTranslation(text, sourceLang, targetLang, resp.translation);

  return { source: text, translation: resp.translation, sourceLang, targetLang };
}

// -----------------------------
// Vocab storage
// -----------------------------

async function saveWord(entry) {
  const { [STORAGE_KEY_VOCAB]: vocab = {} } =
    await chrome.storage.local.get(STORAGE_KEY_VOCAB);
  // Normalized here, not at the call site, so every path into vocab storage
  // (just SAVE_WORD today) gets it automatically — ?utm_source=... and
  // #fragment variants of the same article would otherwise fragment its
  // workbook across several buckets.
  const url = normalizeUrl(entry.url);
  const list = vocab[url] || [];
  list.push({
    ...entry,
    // Never save a bare word: fall back to the source itself if extraction failed.
    contextSentence: entry.contextSentence || entry.source,
    id: crypto.randomUUID(),
    savedAt: Date.now(),
    url
  });
  vocab[url] = list;
  await chrome.storage.local.set({ [STORAGE_KEY_VOCAB]: vocab });
  const count = Object.values(vocab).reduce((sum, arr) => sum + arr.length, 0);
  return { ok: true, count };
}

// One-time migration: vocab used to be a flat array; it's now keyed by URL
// (vocab[url] = [entries]) so per-page workbooks and aggregate views can
// both be computed without scanning unrelated pages' words.
async function migrateVocabToPerUrl() {
  const { [STORAGE_KEY_VOCAB]: vocab } =
    await chrome.storage.local.get(STORAGE_KEY_VOCAB);
  if (!Array.isArray(vocab)) return;

  const migrated = {};
  for (const entry of vocab) {
    const url = entry.url || "unknown";
    (migrated[url] ||= []).push(entry);
  }
  await chrome.storage.local.set({ [STORAGE_KEY_VOCAB]: migrated });
  console.log(
    `[FLA] migrated ${vocab.length} vocab entries into ${Object.keys(migrated).length} URL buckets`
  );
}

// One-time migration: URL keys weren't normalized before, so ?utm_source=...
// and #fragment variants of the same article each got their own bucket.
// Runs after migrateVocabToPerUrl, which this assumes has already happened.
async function migrateVocabUrlNormalization() {
  const { [STORAGE_KEY_VOCAB]: vocab } =
    await chrome.storage.local.get(STORAGE_KEY_VOCAB);
  if (!vocab || Array.isArray(vocab)) return;

  let changed = false;
  const merged = {};
  for (const [url, entries] of Object.entries(vocab)) {
    const normalized = normalizeUrl(url);
    if (normalized !== url) changed = true;
    const bucket = merged[normalized] || [];
    for (const entry of entries) bucket.push({ ...entry, url: normalized });
    merged[normalized] = bucket;
  }
  if (!changed) return;

  await chrome.storage.local.set({ [STORAGE_KEY_VOCAB]: merged });
  console.log(`[FLA] normalized vocab URL keys into ${Object.keys(merged).length} buckets`);
}

// -----------------------------
// Message router
// -----------------------------

// chrome.runtime.sendMessage fans a message out to every OTHER extension
// context (a sender never receives its own broadcast, so this service
// worker's own OFFSCREEN_TRANSLATE call to the offscreen document doesn't
// loop back here) — but the offscreen document's TRANSLATE_STATUS broadcast
// *is* a different context and does land on this listener. Without this
// allowlist it would silently fall through with nothing to reply, leaving
// the implicit response channel open for no reason on every status ping.
const HANDLED_MESSAGE_TYPES = new Set([
  "TRANSLATE",
  "SAVE_WORD",
  "CONJUGATE",
  "OPEN_SIDEPANEL"
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!HANDLED_MESSAGE_TYPES.has(msg.type)) return false;

  (async () => {
    try {
      switch (msg.type) {
        case "TRANSLATE": {
          const result = await translate(msg.text, msg.contextSentence, sender.tab?.id);
          sendResponse(result);
          break;
        }
        case "SAVE_WORD": {
          const withUrl = { ...msg.entry, url: sender.tab?.url };
          const res = await saveWord(withUrl);
          sendResponse(res);
          break;
        }
        case "CONJUGATE": {
          const table = await conjugate(msg.verb);
          if (!table) {
            sendResponse({ error: `Not a known verb: ${msg.verb}` });
          } else {
            sendResponse({ ok: true, table });
          }
          break;
        }
        case "OPEN_SIDEPANEL": {
          if (sender.tab?.id) {
            await chrome.sidePanel.open({ tabId: sender.tab.id });
            // Store view intent for the side panel to pick up on load
            await chrome.storage.local.set({
              sidepanelIntent: { view: msg.view, verb: msg.verb, at: Date.now() }
            });
          }
          sendResponse({ ok: true });
          break;
        }
      }
    } catch (err) {
      console.error("[FLA service worker]", err);
      sendResponse({ error: err.message });
    }
  })();
  return true; // keep the message channel open for async
});

// Relays the offscreen document's one-time "downloading the language pack"
// notice to whichever tab asked for the translation. Separate listener from
// the one above: this is a fire-and-forget broadcast, not a request/response
// pair, so it deliberately never calls sendResponse.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TRANSLATE_STATUS" && msg.tabId) {
    chrome.tabs.sendMessage(msg.tabId, { type: "TRANSLATE_STATUS", status: msg.status }).catch(() => {});
  }
});

// -----------------------------
// Keyboard commands
// -----------------------------

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === "toggle-hover-translate") {
    const { hoverModeEnabled = false } = await chrome.storage.local.get(
      "hoverModeEnabled"
    );
    const next = !hoverModeEnabled;
    await chrome.storage.local.set({ hoverModeEnabled: next });
    chrome.tabs.sendMessage(tab.id, { type: "SET_HOVER_MODE", enabled: next });
  }
  if (command === "read-selection") {
    chrome.tabs.sendMessage(tab.id, { type: "READ_SELECTION", lang: "fr" });
  }
  if (command === "save-word") {
    chrome.tabs.sendMessage(tab.id, { type: "SAVE_SELECTION" });
  }
});

// Enable side panel to open from action click as fallback
chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => {});
  // Sequential, not Promise.all — URL normalization assumes the per-URL
  // shape the first migration produces.
  await migrateVocabToPerUrl();
  await migrateVocabUrlNormalization();
  ensureCacheEvictionAlarm();
});
