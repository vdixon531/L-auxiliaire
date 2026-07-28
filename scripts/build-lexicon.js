// build-lexicon.js
// Converts the Lexique.org word-form database into a sharded JSON dictionary
// that background/lexicon.js reads from:
//   data/lexicon/<letter>.json — surface form -> {lemma, pos, gender, number, freqRank}
// Sharded by the normalized (lowercased, accent-stripped) first letter of the
// key, same scheme as data/verbs/ and data/lemmas/ (see build-verbiste.js).
//
// Source data: data/Lexique4/Lexique4.tsv (189,864 rows, one per distinct
// (spelling, grammatical reading) pair — e.g. "ferme" appears as VER/ADV/ADJ/
// NOM in four separate rows). Columns used (0-indexed):
//   0 Mot (surface form), 3 Lemme, 4 Cgram (NOM/VER/ADJ/ADV/...),
//   6 Genre (blank/e=épicène/f/m), 7 Nombre (blank/i=invariable/p/s),
//   9 FreqMot (frequency of this exact word+category reading),
//   10 FreqOrtho (frequency of this exact SPELLING aggregated across all its
//   grammatical readings — verified identical across homograph rows sharing a
//   Mot), 13 IsLem (1 if this row's Mot is itself the lemma).
//
// Since the output is keyed by surface form (one entry per spelling), the
// ~17k homographs (same spelling, different Cgram) must collapse to a single
// entry: we keep the reading with the highest FreqMot as representative for
// lemma/pos/gender/number (falling back to the IsLem row, then file order, on
// ties), but rank by FreqOrtho — the spelling's true aggregate frequency,
// i.e. what a reader actually encounters regardless of which sense it is.
// This means a word's less-common reading goes unrepresented (e.g. "marche"
// is tagged VER even in sentences using it as the noun) — a heuristic
// annotation for color-coding/dimming, not a real POS tagger.
//
// Run with: node scripts/build-lexicon.js

const fs = require("fs");
const path = require("path");
const { normalize, shardKeyOf, writeSharded } = require("./shard-writer.js");

const SRC_PATH = path.join(__dirname, "..", "data", "Lexique4", "Lexique4.tsv");
const OUT_DIR = path.join(__dirname, "..", "data", "lexicon");
const TOP_N = 30000;

const COL = {
  mot: 0,
  lemme: 3,
  cgram: 4,
  genre: 6,
  nombre: 7,
  freqMot: 9,
  freqOrtho: 10,
  isLem: 13
};

function parseRows(tsv) {
  const lines = tsv.split(/\r?\n/);
  const rows = [];
  // Skip the header row.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split("\t");
    rows.push({
      mot: f[COL.mot],
      lemme: f[COL.lemme],
      cgram: f[COL.cgram] || null,
      genre: f[COL.genre] || null,
      nombre: f[COL.nombre] || null,
      freqMot: parseFloat(f[COL.freqMot]) || 0,
      freqOrtho: parseFloat(f[COL.freqOrtho]) || 0,
      isLem: f[COL.isLem] === "1"
    });
  }
  return rows;
}

// One representative row per distinct spelling: highest FreqMot wins, ties
// broken by preferring the row that IS the lemma, then by file order.
function dedupeBySpelling(rows) {
  const bestBySpelling = new Map();
  let homographCount = 0;
  for (const row of rows) {
    const existing = bestBySpelling.get(row.mot);
    if (!existing) {
      bestBySpelling.set(row.mot, row);
      continue;
    }
    homographCount++;
    const better =
      row.freqMot > existing.freqMot ||
      (row.freqMot === existing.freqMot && row.isLem && !existing.isLem);
    if (better) bestBySpelling.set(row.mot, row);
  }
  return { bestBySpelling, homographCount };
}

function main() {
  const tsv = fs.readFileSync(SRC_PATH, "utf8");
  const rows = parseRows(tsv);
  const { bestBySpelling, homographCount } = dedupeBySpelling(rows);

  // Rank by FreqOrtho (the spelling's own aggregate frequency), not by the
  // representative row's FreqMot, since FreqOrtho is what actually governs
  // how often a reader encounters this exact printed string.
  const ranked = [...bestBySpelling.values()].sort((a, b) => b.freqOrtho - a.freqOrtho);
  const top = ranked.slice(0, TOP_N);

  const shards = {};
  top.forEach((row, i) => {
    const key = shardKeyOf(normalize(row.mot));
    (shards[key] ??= {})[row.mot] = {
      lemma: row.lemme,
      pos: row.cgram,
      gender: row.genre,
      number: row.nombre,
      freqRank: i + 1
    };
  });
  const shardCount = writeSharded(OUT_DIR, shards);

  const cutoffFreqOrtho = top[top.length - 1]?.freqOrtho ?? 0;
  console.log(`Parsed ${rows.length} rows (${bestBySpelling.size} unique spellings, ${homographCount} homograph readings collapsed)`);
  console.log(`Wrote top ${top.length} spellings across ${shardCount} shards to ${OUT_DIR}`);
  console.log(`freqRank ${TOP_N} cutoff FreqOrtho: ${cutoffFreqOrtho}`);
}

main();
