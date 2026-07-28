// pdf-handoff.js
// Hands a PDF's raw bytes off from wherever they were obtained (a local file
// picked in the popup, or fetched from a page already showing a PDF) to the
// pdf-viewer tab that renders them. A tab created via chrome.tabs.create()
// can only be pointed at a URL, and there's no way to carry binary data
// through a URL string, so the bytes are staged here under a random token
// and picked up by the viewer instead.
//
// IndexedDB, not chrome.storage.session: session storage has no confirmed
// structured-clone support for ArrayBuffer and only a 10MB quota — base64
// encoding to fit would cap usable PDF size around ~7.5MB, too small for
// scanned documents/textbooks. IndexedDB stores ArrayBuffers natively via
// structured clone with a much larger practical quota.

const DB_NAME = "fla-pdf-handoff";
const DB_VERSION = 1;
const STORE_NAME = "blobs";

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "token" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putHandoff(arrayBuffer, filename) {
  const token = crypto.randomUUID();
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ token, arrayBuffer, filename, at: Date.now() });
    await txDone(tx);
    return token;
  } finally {
    db.close();
  }
}

// Deliberately does NOT delete the record after reading — an accidental
// reload (F5) of the viewer tab should still find its PDF. Stale records are
// cleaned up later by sweepStaleHandoffs(), not on read.
export async function takeHandoff(token) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, "readonly");
    const record = await requestToPromise(tx.objectStore(STORE_NAME).get(token));
    await txDone(tx);
    if (!record) return null;
    return { arrayBuffer: record.arrayBuffer, filename: record.filename, at: record.at };
  } finally {
    db.close();
  }
}

export async function sweepStaleHandoffs(maxAgeMs) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const all = await requestToPromise(store.getAll());
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const record of all) {
      if (record.at < cutoff) {
        store.delete(record.token);
        removed++;
      }
    }
    await txDone(tx);
    return removed;
  } finally {
    db.close();
  }
}
