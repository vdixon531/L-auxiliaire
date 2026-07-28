// build-verbiste.js
// Converts the Verbiste XML dataset into two sharded JSON directories that
// background/conjugation.js reads from:
//   data/verbs/<letter>.json  — infinitive -> {template, tenses}
//   data/lemmas/<letter>.json — normalized surface form -> infinitive
// Sharded by the normalized (lowercased, accent-stripped) first letter of
// the key, so a runtime lookup parses ~1/26th of the dataset instead of all
// of it — loading the whole thing every service-worker wake previously cost
// ~550ms and 76MB just to answer one word's conjugation.
//
// Source data: scripts/verbiste-source/{conjugations-fr.xml,verbs-fr.xml}
// Originally by Pierre Sarrazin (http://sarrazip.com/), GPL-2.0-or-later.
// This mirror (with lowercased tense tags + EN glosses) comes from
// https://github.com/bretttolbert/verbecc (Brett Tolbert, GPL-2.0-or-later).
//
// Each <template name="prefix:suffix"> gives, per tense, one <p><i>ending</i></p>
// per form. A verb's conjugated forms are its own root (infinitive with the
// template's suffix stripped) plus each ending — the doubled consonants,
// stem vowel changes, etc. are already baked into the endings, so no separate
// stem-alternation logic is needed. Run with: node scripts/build-verbiste.js

const fs = require("fs");
const path = require("path");
const { normalize, shardKeyOf, writeSharded } = require("./shard-writer.js");

const SRC_DIR = path.join(__dirname, "verbiste-source");
const CONJUGATIONS_PATH = path.join(SRC_DIR, "conjugations-fr.xml");
const VERBS_PATH = path.join(SRC_DIR, "verbs-fr.xml");
const VERBS_OUT_DIR = path.join(__dirname, "..", "data", "verbs");
const LEMMAS_OUT_DIR = path.join(__dirname, "..", "data", "lemmas");

// Fixed positional layout of the 51 <i> tags per <template>, per the DTD:
// Infinitif(1) Indicatif(6+6+6+6) Conditionnel(6) Subjonctif(6+6) Imperatif(3) Participe(1+4)
const SLICES = [
  ["__infinitif", 0, 1],
  ["présent", 1, 7],
  ["imparfait", 7, 13],
  ["futur", 13, 19],
  ["passé simple", 19, 25],
  ["conditionnel", 25, 31],
  ["subjonctif présent", 31, 37],
  ["subjonctif imparfait", 37, 43],
  ["impératif", 43, 46],
  ["participe présent", 46, 47],
  ["participe passé", 47, 51]
];

function parseTemplates(xml) {
  const templates = new Map();
  const templateRe = /<template name="([^"]+)">([\s\S]*?)<\/template>/g;
  let m;
  while ((m = templateRe.exec(xml))) {
    const [, name, body] = m;
    // Each <p> holds one canonical form plus, occasionally, post-1990-reform
    // spelling alternates as extra <i> siblings — we only want the first.
    const pBlocks = [...body.matchAll(/<p>([\s\S]*?)<\/p>/g)];
    if (pBlocks.length !== 51) {
      throw new Error(`Template "${name}" has ${pBlocks.length} forms, expected 51`);
    }
    const endings = pBlocks.map(([, pBody]) => (pBody.match(/<i>([^<]*)<\/i>/) || [, ""])[1]);
    const tenses = {};
    for (const [tense, start, end] of SLICES) {
      tenses[tense] = endings.slice(start, end);
    }
    templates.set(name, tenses);
  }
  return templates;
}

function parseVerbs(xml) {
  const verbs = [];
  const verbRe = /<v><i>([^<]+)<\/i><t>([^<]+)<\/t>/g;
  let m;
  while ((m = verbRe.exec(xml))) {
    verbs.push({ infinitive: m[1], template: m[2] });
  }
  return verbs;
}

function conjugate(infinitive, templateName, templateTenses) {
  const colonIdx = templateName.indexOf(":");
  const suffix = templateName.slice(colonIdx + 1);
  const root = infinitive.slice(0, infinitive.length - suffix.length);

  const [rebuiltInfinitive] = templateTenses.__infinitif.map((e) => root + e);
  if (rebuiltInfinitive !== infinitive) {
    console.warn(
      `[build-verbiste] "${infinitive}" (template ${templateName}) rebuilds as "${rebuiltInfinitive}" — check root/suffix split`
    );
  }

  const tenses = {};
  for (const [tense] of SLICES) {
    if (tense === "__infinitif") continue;
    tenses[tense] = templateTenses[tense].map((ending) => root + ending);
  }
  return tenses;
}

function main() {
  const conjugationsXml = fs.readFileSync(CONJUGATIONS_PATH, "utf8");
  const verbsXml = fs.readFileSync(VERBS_PATH, "utf8");

  const templates = parseTemplates(conjugationsXml);
  const verbs = parseVerbs(verbsXml);

  const out = {}; // infinitive -> {template, tenses}, in memory only — never written whole
  let skipped = 0;
  for (const { infinitive, template } of verbs) {
    const templateTenses = templates.get(template);
    if (!templateTenses) {
      console.warn(`[build-verbiste] no template "${template}" for verb "${infinitive}", skipping`);
      skipped++;
      continue;
    }
    out[infinitive] = {
      template,
      tenses: conjugate(infinitive, template, templateTenses)
    };
  }

  // Shard the forward data by the infinitive's own normalized first letter.
  const verbShards = {};
  for (const [infinitive, entry] of Object.entries(out)) {
    const key = shardKeyOf(normalize(infinitive));
    (verbShards[key] ??= {})[infinitive] = entry;
  }
  const verbShardCount = writeSharded(VERBS_OUT_DIR, verbShards);

  // Build the reverse index (surface form -> infinitive) once here, instead
  // of on every service-worker cold start. A handful of forms are genuine
  // homographs across two verbs (e.g. "admirent" is both admirer's présent
  // and admettre's passé simple) — resolve the same deterministic
  // alphabetical tie-break background/conjugation.js used to do at runtime,
  // so behavior is unchanged, just precomputed. Sharded by the SURFACE
  // FORM's first letter, which often differs from its infinitive's ("vont"
  // and "aller" land in different shards) — that's why conjugate() may need
  // to load a second verb shard after resolving the lemma.
  const lemmaCandidates = new Map(); // normalizedForm -> Set<infinitive>
  for (const [infinitive, entry] of Object.entries(out)) {
    const forms = new Set([infinitive]);
    for (const tenseForms of Object.values(entry.tenses)) {
      for (const form of tenseForms) if (form) forms.add(form);
    }
    for (const form of forms) {
      const key = normalize(form);
      let set = lemmaCandidates.get(key);
      if (!set) {
        set = new Set();
        lemmaCandidates.set(key, set);
      }
      set.add(infinitive);
    }
  }

  const lemmaShards = {};
  for (const [normForm, candidates] of lemmaCandidates) {
    const winner = [...candidates].sort()[0];
    const key = shardKeyOf(normForm);
    (lemmaShards[key] ??= {})[normForm] = winner;
  }
  const lemmaShardCount = writeSharded(LEMMAS_OUT_DIR, lemmaShards);

  console.log(`Wrote ${Object.keys(out).length} verbs (${skipped} skipped) across ${verbShardCount} shards to ${VERBS_OUT_DIR}`);
  console.log(`Wrote ${lemmaCandidates.size} surface forms across ${lemmaShardCount} shards to ${LEMMAS_OUT_DIR}`);
  console.log(`Templates parsed: ${templates.size}`);
}

main();
