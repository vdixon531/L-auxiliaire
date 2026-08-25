// service-worker.js
// Handles: translation orchestration (actual API calls happen in the
// offscreen document), vocab storage, conjugation lookups, side panel
// orchestration, keyboard commands.

import { conjugate, isKnownVerb, resolveLemma } from "./conjugation.js";
import { getCachedTranslation, setCachedTranslation, ensureCacheEvictionAlarm } from "./cache.js";
import { detectLang } from "./detect-lang.js";
import { normalizeUrl } from "../lib/normalize-url.js";
import { dueAtForBox } from "./srs.js";
import { lookupWord, annotateWords } from "./lexicon.js";
import { sweepStaleHandoffs } from "../lib/pdf-handoff.js";

const STORAGE_KEY_VOCAB = "vocab";
const STORAGE_KEY_CARDS = "cards";
const STORAGE_KEY_VERBS = "verbs";
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
//
// `vocab[url]` holds occurrences — one per save, carrying the context
// sentence for that specific page. SRS state does NOT live there: the same
// word saved from two different pages is one card to review, not two, so
// box/dueAt/etc. live in `cards`, keyed by lemma, with each occurrence
// pointing at its card via `cardId`. This also means a due-review query
// scans `cards` (one entry per distinct word) instead of every URL bucket.

function buildCard(lemma, entry, contextSentence, occurrenceRef, savedAt) {
  return {
    lemma,
    sourceLang: entry.sourceLang,
    targetLang: entry.targetLang,
    translation: entry.translation,
    pos: entry.pos,
    gender: entry.gender,
    plural: entry.plural,
    contextSentence,
    occurrenceIds: [occurrenceRef],
    box: 1,
    dueAt: dueAtForBox(1, savedAt),
    lastReviewedAt: null,
    correctStreak: 0,
    totalReviews: 0,
    createdAt: savedAt
  };
}

async function saveWord(rawEntry) {
  const { [STORAGE_KEY_VOCAB]: vocab = {}, [STORAGE_KEY_CARDS]: cards = {} } =
    await chrome.storage.local.get([STORAGE_KEY_VOCAB, STORAGE_KEY_CARDS]);
  // Normalized here, not at the call site, so every path into vocab storage
  // (just SAVE_WORD today) gets it automatically — ?utm_source=... and
  // #fragment variants of the same article would otherwise fragment its
  // workbook across several buckets.
  const url = normalizeUrl(rawEntry.url);
  const savedAt = Date.now();
  // Never save a bare word: fall back to the source itself if extraction failed.
  const contextSentence = rawEntry.contextSentence || rawEntry.source;
  const lemma = await resolveLemma(rawEntry.source);

  // pos/gender/plural have existed on vocab occurrences/cards since Phase 1
  // but nothing ever populated them — fill them from the bundled lexicon when
  // the caller didn't already supply them (content-script never does today).
  // lookupWord's own whitespace guard makes this a safe no-op for phrase saves.
  const lexEntry = await lookupWord(rawEntry.source);
  const entry = {
    ...rawEntry,
    pos: rawEntry.pos ?? lexEntry?.pos,
    gender: rawEntry.gender ?? lexEntry?.gender,
    plural: rawEntry.plural ?? (lexEntry ? lexEntry.number === "p" : undefined)
  };
  const occurrenceId = crypto.randomUUID();

  const list = vocab[url] || [];
  list.push({
    ...entry,
    contextSentence,
    id: occurrenceId,
    cardId: lemma,
    savedAt,
    url
  });
  vocab[url] = list;

  const occurrenceRef = { url, id: occurrenceId };
  const existingCard = cards[lemma];
  if (existingCard) {
    // Re-encountering a known word updates its display fields (latest
    // translation/context) but never touches box/dueAt/streak — only an
    // actual review (RECORD_REVIEW, Phase 3) changes SRS state.
    existingCard.translation = entry.translation;
    existingCard.pos = entry.pos;
    existingCard.gender = entry.gender;
    existingCard.plural = entry.plural;
    existingCard.contextSentence = contextSentence;
    existingCard.occurrenceIds.push(occurrenceRef);
  } else {
    cards[lemma] = buildCard(lemma, entry, contextSentence, occurrenceRef, savedAt);
  }

  await chrome.storage.local.set({ [STORAGE_KEY_VOCAB]: vocab, [STORAGE_KEY_CARDS]: cards });
  const count = Object.values(vocab).reduce((sum, arr) => sum + arr.length, 0);
  return { ok: true, count };
}

// One-time migration: hoverModeEnabled used to live as a top-level storage
// key; CLAUDE.md always documented it as nested under config, and
// popup.js/content-script.js/this file now agree with that, so fold any
// pre-existing top-level value in before dropping it. Also drops
// config.cursorFollowMode entirely — cursor-follow mode (the reticle +
// click-only alternative to hover) was removed; click-to-translate is now
// always on, so that setting no longer means anything, wherever it lives.
async function migrateHoverModeIntoConfig() {
  const { hoverModeEnabled, cursorFollowMode, [STORAGE_KEY_CONFIG]: config = {} } =
    await chrome.storage.local.get(["hoverModeEnabled", "cursorFollowMode", STORAGE_KEY_CONFIG]);

  const merged = { ...config };
  let changed = false;
  if (hoverModeEnabled !== undefined) {
    merged.hoverModeEnabled = hoverModeEnabled;
    changed = true;
  }
  if (cursorFollowMode !== undefined) changed = true; // legacy top-level key — drop, don't migrate in
  if (merged.cursorFollowMode !== undefined) {
    delete merged.cursorFollowMode;
    changed = true;
  }
  if (!changed) return;

  await chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: merged });
  await chrome.storage.local.remove(["hoverModeEnabled", "cursorFollowMode"]);
  console.log("[FLA] migrated hoverModeEnabled into config; dropped retired cursorFollowMode");
}

// -----------------------------
// Verb workbook storage
// -----------------------------

async function saveVerb(table) {
  const { [STORAGE_KEY_VERBS]: verbs = [] } =
    await chrome.storage.local.get(STORAGE_KEY_VERBS);
  verbs.push({ ...table, savedAt: Date.now(), id: crypto.randomUUID() });
  await chrome.storage.local.set({ [STORAGE_KEY_VERBS]: verbs });
  return { ok: true };
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

// One-time migration: SRS fields used to be documented as living inline per
// occurrence, which meant the same word saved from two pages would become
// two independent cards and a due-review query would have to scan every URL
// bucket. Builds the `cards` store (keyed by lemma) from existing vocab
// occurrences. Runs after the two migrations above, since it needs final
// (per-URL, normalized) vocab keys and stamps each occurrence with cardId.
async function migrateVocabToCards() {
  const { [STORAGE_KEY_VOCAB]: vocab, [STORAGE_KEY_CARDS]: cards } =
    await chrome.storage.local.get([STORAGE_KEY_VOCAB, STORAGE_KEY_CARDS]);
  if (!vocab || cards) return; // nothing to migrate, or already migrated

  const builtCards = {};
  // Tracked separately from card.createdAt: createdAt becomes the EARLIEST
  // occurrence (first exposure, so dueAt reflects when the word was first
  // learned), while this tracks the MOST RECENT one, so display fields
  // (translation/context) always end up reflecting the latest save
  // regardless of what order Object.entries(vocab) happens to visit URLs in.
  const latestSavedAt = {};
  const migratedVocab = {};
  for (const [url, entries] of Object.entries(vocab)) {
    migratedVocab[url] = [];
    for (const entry of entries) {
      const lemma = await resolveLemma(entry.source);
      migratedVocab[url].push({ ...entry, cardId: lemma });

      const occurrenceRef = { url, id: entry.id };
      const existing = builtCards[lemma];
      if (!existing) {
        builtCards[lemma] = buildCard(lemma, entry, entry.contextSentence, occurrenceRef, entry.savedAt);
        latestSavedAt[lemma] = entry.savedAt;
        continue;
      }

      existing.occurrenceIds.push(occurrenceRef);
      if (entry.savedAt < existing.createdAt) {
        existing.createdAt = entry.savedAt;
        existing.dueAt = dueAtForBox(existing.box, entry.savedAt);
      }
      if (entry.savedAt >= latestSavedAt[lemma]) {
        existing.translation = entry.translation;
        existing.pos = entry.pos;
        existing.gender = entry.gender;
        existing.plural = entry.plural;
        existing.contextSentence = entry.contextSentence;
        latestSavedAt[lemma] = entry.savedAt;
      }
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEY_VOCAB]: migratedVocab, [STORAGE_KEY_CARDS]: builtCards });
  console.log(`[FLA] built ${Object.keys(builtCards).length} SRS cards from existing vocab occurrences`);
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
  "SAVE_VERB",
  "CONJUGATE",
  "OPEN_SIDEPANEL",
  "LOOKUP_WORDS"
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
          // Respect an explicit url the caller already computed (pdf-viewer/
          // viewer.js sends its own pdf:<sha256hex> content-hash key, since
          // sender.tab.url there would just be the viewer's own
          // chrome-extension://.../viewer.html?handoff=... address) — only
          // fall back to the sending tab's URL when the caller didn't supply one.
          const withUrl = { ...msg.entry, url: msg.entry.url || sender.tab?.url };
          const res = await saveWord(withUrl);
          sendResponse(res);
          break;
        }
        case "SAVE_VERB": {
          const res = await saveVerb(msg.table);
          sendResponse(res);
          break;
        }
        case "LOOKUP_WORDS": {
          const result = await annotateWords(msg.words);
          sendResponse(result);
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
              sidepanelIntent: { view: msg.view, verb: msg.verb, text: msg.text, at: Date.now() }
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
// PDF handoff sweep (pdf-viewer manual-open flow)
// -----------------------------
//
// A picked/fetched PDF's bytes sit in lib/pdf-handoff.js's IndexedDB store
// just long enough for the new viewer tab to read them — sweeps here the
// same way cache.js sweeps stale translations, rather than deleting on read,
// so an accidental viewer-tab reload doesn't strand the user.

const PDF_HANDOFF_SWEEP_ALARM_NAME = "fla-pdf-handoff-sweep";
const PDF_HANDOFF_SWEEP_PERIOD_MINUTES = 15;
const PDF_HANDOFF_MAX_AGE_MS = 30 * 60 * 1000; // 30m — ample time for a new tab to load and read it

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PDF_HANDOFF_SWEEP_ALARM_NAME) sweepStaleHandoffs(PDF_HANDOFF_MAX_AGE_MS);
});

async function ensureHandoffSweepAlarm() {
  const existing = await chrome.alarms.get(PDF_HANDOFF_SWEEP_ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(PDF_HANDOFF_SWEEP_ALARM_NAME, { periodInMinutes: PDF_HANDOFF_SWEEP_PERIOD_MINUTES });
  }
}

// -----------------------------
// Keyboard commands
// -----------------------------

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === "toggle-hover-translate") {
    const { [STORAGE_KEY_CONFIG]: config = {} } =
      await chrome.storage.local.get(STORAGE_KEY_CONFIG);
    const next = !config.hoverModeEnabled;
    await chrome.storage.local.set({
      [STORAGE_KEY_CONFIG]: { ...config, hoverModeEnabled: next }
    });
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
  await migrateHoverModeIntoConfig();
  // Sequential, not Promise.all — each migration assumes the shape the
  // previous one produces (per-URL keying, then normalized URL keys, then
  // cards built from the final vocab).
  await migrateVocabToPerUrl();
  await migrateVocabUrlNormalization();
  await migrateVocabToCards();
  ensureCacheEvictionAlarm();
  ensureHandoffSweepAlarm();
});
