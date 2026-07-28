// cache.js
// Caches TRANSLATE results so re-hovering/re-selecting the same word (common
// while reading a page) skips redundant work — a fresh lookup still means
// crossing into the offscreen document and invoking the on-device model.
// See CLAUDE.md for the translationCache storage shape.
//
// Each entry is its own top-level chrome.storage.local key ("tc:<hash>"),
// not one shared object — chrome.storage.local.set only touches the keys
// you pass it, so a cache write is O(1) regardless of how many other
// entries exist. The previous design stored all entries in one object under
// a single key, meaning every miss read, mutated, and rewrote the entire
// cache. TTL expiry and the 5000-entry cap are enforced by a periodic sweep
// (chrome.alarms) instead of on every write, since there's no cheap way to
// count/rank per-key entries without reading them all anyway — better to
// pay that cost every few hours than on every translation.

const PREFIX = "tc:";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ENTRIES = 5000;
const SWEEP_ALARM_NAME = "fla-translation-cache-sweep";
const SWEEP_PERIOD_MINUTES = 6 * 60; // 6h — the cache can temporarily exceed
// MAX_ENTRIES between sweeps; each entry is small enough that this is a
// storage-quota non-issue, and it's the tradeoff that makes writes O(1).

// Cheap, non-cryptographic hash (FNV-1a) — this is a cache key, not a
// security boundary, so collision resistance just needs to be "good enough".
function hashKey(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return PREFIX + (hash >>> 0).toString(36);
}

function storageKey(text, sourceLang, targetLang) {
  return hashKey(`${sourceLang}:${targetLang}:${text}`);
}

// Date.now() only has millisecond resolution, and eviction below needs a
// strict write order to rank by. A burst of writes landing in the same
// millisecond (plausible: cache misses trigger on-device translation, which
// is fast) would otherwise tie, and — because a stable sort preserves
// original order within a tie, while the sweep slices off the *tail* of the
// sorted list — ties get evicted backwards: newer entries removed, older
// ones kept. Folding a same-process write sequence number into a tiny
// fractional part makes ts strictly increasing per write, at a precision
// (1/1000 ms) that's irrelevant to the 7-day TTL check.
let lastTsMs = 0;
let tsSeq = 0;
function nextTs() {
  const nowMs = Date.now();
  if (nowMs === lastTsMs) {
    tsSeq++;
  } else {
    lastTsMs = nowMs;
    tsSeq = 0;
  }
  return nowMs + tsSeq / 1000;
}

export async function getCachedTranslation(text, sourceLang, targetLang) {
  const key = storageKey(text, sourceLang, targetLang);
  const { [key]: entry } = await chrome.storage.local.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) return null;
  return entry.translation;
}

export async function setCachedTranslation(text, sourceLang, targetLang, translation) {
  const key = storageKey(text, sourceLang, targetLang);
  await chrome.storage.local.set({
    [key]: { translation, sourceLang, targetLang, ts: nextTs() }
  });
}

// Exported for testing; runs on the alarm below in normal operation.
export async function sweepCache() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const entries = Object.keys(all)
    .filter((k) => k.startsWith(PREFIX))
    .map((k) => [k, all[k].ts]);

  const stale = entries.filter(([, ts]) => now - ts > TTL_MS).map(([k]) => k);

  const live = entries.filter(([, ts]) => now - ts <= TTL_MS);
  live.sort((a, b) => b[1] - a[1]); // newest first
  const overflow = live.slice(MAX_ENTRIES).map(([k]) => k);

  const toRemove = [...new Set([...stale, ...overflow])];
  if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
  return toRemove.length;
}

// Registered unconditionally at module load — same as every other
// chrome.*.onEvent listener in this extension. MV3 service workers need
// listeners attached synchronously on every wake, not just after setup ran.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM_NAME) sweepCache();
});

// Called once from onInstalled — chrome.alarms persists the schedule across
// service-worker restarts on its own, so this only needs to run on install
// or update, not on every wake (chrome.alarms.create would otherwise reset
// the period's start time every time, which is harmless but pointless).
export async function ensureCacheEvictionAlarm() {
  const existing = await chrome.alarms.get(SWEEP_ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(SWEEP_ALARM_NAME, { periodInMinutes: SWEEP_PERIOD_MINUTES });
  }
}
