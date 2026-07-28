// offscreen.js
// Runs Chrome's built-in on-device Translator API. This has to live in an
// offscreen document (not the service worker) because the API "isn't
// available in Web Workers, due to the complexity of establishing a
// responsible document for each worker" — a Manifest V3 service worker *is*
// a Web Worker. service-worker.js spawns this page and relays through it.
// https://developer.chrome.com/docs/ai/translator-api

const translators = new Map(); // "sourceLang:targetLang" -> Translator, cached for this document's lifetime

async function getTranslator(sourceLanguage, targetLanguage, onDownloading) {
  const key = `${sourceLanguage}:${targetLanguage}`;
  const existing = translators.get(key);
  if (existing) return existing;

  if (!("Translator" in self)) {
    throw new Error("On-device translation needs Chrome 138 or newer.");
  }

  const availability = await Translator.availability({ sourceLanguage, targetLanguage });
  if (availability === "unavailable") {
    throw new Error(`No on-device model for ${sourceLanguage} → ${targetLanguage} on this device.`);
  }
  // "downloadable" or "downloading" both mean the language pack isn't ready
  // yet and this call may block for a while fetching it.
  if (availability !== "available") onDownloading();

  const translator = await Translator.create({ sourceLanguage, targetLanguage });
  translators.set(key, translator);
  return translator;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "OFFSCREEN_TRANSLATE") return false; // not ours; let the real recipient handle it

  (async () => {
    try {
      const translator = await getTranslator(msg.sourceLang, msg.targetLang, () => {
        // Fire-and-forget: a one-time heads-up so the bubble doesn't look
        // hung during the (one-time, per-language-pair) model download.
        chrome.runtime.sendMessage({
          type: "TRANSLATE_STATUS",
          tabId: msg.tabId,
          status: "downloading"
        }).catch(() => {});
      });
      const translation = await translator.translate(msg.text);
      sendResponse({ ok: true, translation });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});
