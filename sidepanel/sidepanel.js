// sidepanel.js

const $ = (id) => document.getElementById(id);

// -----------------------------
// Tabs
// -----------------------------

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

function switchView(view) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === view));
  if (view === "vocab") renderVocab();
}

// -----------------------------
// Vocab list
// -----------------------------

async function renderVocab(filter = "") {
  const { vocab = {} } = await chrome.storage.local.get("vocab");
  const allEntries = Object.values(vocab).flat();
  const list = $("vocabList");
  list.innerHTML = "";
  const filtered = filter
    ? allEntries.filter(
        (v) =>
          v.source.toLowerCase().includes(filter.toLowerCase()) ||
          v.translation.toLowerCase().includes(filter.toLowerCase())
      )
    : allEntries;

  if (filtered.length === 0) {
    list.innerHTML = `<li class="empty">No saved words yet.</li>`;
    return;
  }

  filtered
    .slice()
    .reverse()
    .forEach((entry) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="entry">
          <div class="entry-source">
            <span class="lang">${entry.sourceLang}</span>
            ${escapeHtml(entry.source)}
            <button class="speak" data-text="${escapeAttr(entry.source)}" data-lang="${entry.sourceLang}">▶</button>
          </div>
          <div class="entry-translation">
            <span class="lang">${entry.targetLang}</span>
            ${escapeHtml(entry.translation)}
            <button class="speak" data-text="${escapeAttr(entry.translation)}" data-lang="${entry.targetLang}">▶</button>
          </div>
          ${entry.contextSentence ? `<div class="entry-context">${escapeHtml(entry.contextSentence)}</div>` : ""}
          <button class="delete" data-id="${entry.id}" data-url="${escapeAttr(entry.url || "")}">×</button>
        </div>
      `;
      list.appendChild(li);
    });

  list.querySelectorAll(".speak").forEach((b) =>
    b.addEventListener("click", () => speak(b.dataset.text, b.dataset.lang))
  );
  list.querySelectorAll(".delete").forEach((b) =>
    b.addEventListener("click", () => deleteEntry(b.dataset.url, b.dataset.id))
  );
}

async function deleteEntry(url, id) {
  const { vocab = {}, cards = {} } = await chrome.storage.local.get(["vocab", "cards"]);
  const bucket = url || "unknown";
  const removed = vocab[bucket]?.find((v) => v.id === id);
  if (vocab[bucket]) {
    vocab[bucket] = vocab[bucket].filter((v) => v.id !== id);
    if (vocab[bucket].length === 0) delete vocab[bucket];
  }

  // Drop this occurrence's pointer from its card; if that was the card's
  // last occurrence, the word isn't saved anywhere anymore, so it shouldn't
  // keep coming up for review either.
  const card = removed && cards[removed.cardId];
  if (card) {
    card.occurrenceIds = card.occurrenceIds.filter((ref) => !(ref.url === bucket && ref.id === id));
    if (card.occurrenceIds.length === 0) delete cards[removed.cardId];
  }

  await chrome.storage.local.set({ vocab, cards });
  renderVocab($("vocabSearch").value);
}

$("vocabSearch").addEventListener("input", (e) => renderVocab(e.target.value));

// -----------------------------
// Exports
// -----------------------------

$("exportCsv").addEventListener("click", async () => {
  const { vocab = {} } = await chrome.storage.local.get("vocab");
  const entries = Object.values(vocab).flat();
  const rows = [["source", "sourceLang", "translation", "targetLang", "contextSentence", "savedAt", "url"]];
  entries.forEach((v) =>
    rows.push([v.source, v.sourceLang, v.translation, v.targetLang, v.contextSentence || "", new Date(v.savedAt).toISOString(), v.url || ""])
  );
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  downloadBlob(csv, "vocab.csv", "text/csv");
});

$("exportAnki").addEventListener("click", async () => {
  // Anki accepts tab-separated import files.
  const { vocab = {} } = await chrome.storage.local.get("vocab");
  const entries = Object.values(vocab).flat();
  const tsv = entries
    .map((v) => `${csvEscape(v.source)}\t${csvEscape(v.translation)}\t${csvEscape(v.contextSentence || "")}`)
    .join("\n");
  downloadBlob(tsv, "vocab-anki.txt", "text/plain");
});

function csvEscape(s) {
  const str = String(s ?? "");
  return /[",\n\t]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadBlob(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// -----------------------------
// Conjugation
// -----------------------------

$("lookupVerb").addEventListener("click", () => lookupVerb($("verbInput").value.trim()));
$("verbInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") lookupVerb(e.target.value.trim());
});

async function lookupVerb(verb) {
  if (!verb) return;
  const resp = await chrome.runtime.sendMessage({ type: "CONJUGATE", verb });
  const container = $("conjugationTable");
  if (resp?.error) {
    container.innerHTML = `<div class="error">${escapeHtml(resp.error)}</div>`;
    return;
  }
  container.innerHTML = renderConjugationTable(resp.table);
  container.querySelectorAll(".speak").forEach((b) =>
    b.addEventListener("click", () => speak(b.dataset.text, "fr"))
  );
  container.querySelector(".save-verb")?.addEventListener("click", () => saveVerbTable(resp.table));
}

const PRONOUNS = ["je", "tu", "il/elle", "nous", "vous", "ils/elles"];
const IMPERATIF_LABELS = ["tu", "nous", "vous"];
const PARTICIPE_PASSE_LABELS = ["m. sg.", "m. pl.", "f. sg.", "f. pl."];

function labelsForTense(tense) {
  if (tense === "impératif") return IMPERATIF_LABELS;
  if (tense === "participe passé") return PARTICIPE_PASSE_LABELS;
  if (tense === "participe présent") return [""];
  return PRONOUNS;
}

function renderConjugationTable(table) {
  const tenseHtml = Object.entries(table.tenses || {})
    .map(([tense, forms]) => {
      const labels = labelsForTense(tense);
      const rows = forms
        .map((form, i) => `
          <tr>
            <td class="pronoun">${labels[i] || ""}</td>
            <td>${escapeHtml(form)}</td>
            <td><button class="speak" data-text="${escapeAttr((labels[i] || "") + " " + form)}">▶</button></td>
          </tr>
        `)
        .join("");
      return `
        <div class="tense">
          <h3>${escapeHtml(tense)}</h3>
          <table>${rows}</table>
        </div>
      `;
    })
    .join("");
  return `
    <div class="verb-header">
      <h2>${escapeHtml(table.infinitive)}</h2>
      <button class="save-verb">＋ Save to workbook</button>
    </div>
    ${tenseHtml}
  `;
}

async function saveVerbTable(table) {
  await chrome.runtime.sendMessage({ type: "SAVE_VERB", table });
}

// -----------------------------
// TTS
// -----------------------------

function speak(text, langCode) {
  const lang = langCode === "en" ? "en-US" : "fr-FR";
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  utter.rate = 0.9;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

// -----------------------------
// Helpers
// -----------------------------

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// -----------------------------
// Intent handoff from content script
// -----------------------------

async function checkIntent() {
  const { sidepanelIntent } = await chrome.storage.local.get("sidepanelIntent");
  if (!sidepanelIntent) return;
  // Only act on recent intents
  if (Date.now() - sidepanelIntent.at > 5000) return;
  if (sidepanelIntent.view === "conjugation" && sidepanelIntent.verb) {
    switchView("conjugation");
    $("verbInput").value = sidepanelIntent.verb;
    lookupVerb(sidepanelIntent.verb);
  }
  await chrome.storage.local.remove("sidepanelIntent");
}

renderVocab();
checkIntent();
