/**
 * Chrome Web Store packager. Run: node scripts/package.js
 *
 * Stages exactly what should ship into build/<name>-<version>/ and zips it.
 *
 * This exists because Chrome packages the WHOLE directory you point it at.
 * Loading this repo unpacked hands Chrome 67MB of build sources, the docs and
 * the git metadata along with the extension. That's tolerable in development
 * and not something to upload.
 *
 * The staging directory is deliberately left behind after zipping: load it
 * unpacked to test the exact artifact you're about to submit, rather than
 * testing the repo and uploading something different.
 *
 * LICENSE and NOTICE.md are included on purpose. The project is
 * GPL-2.0-or-later and bundles Apache-2.0 and CC BY-SA 4.0 work; all three
 * require their notices to travel with the distributed copy. Dropping them
 * from the zip to save 20KB would be a licence violation.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

// Everything the browser needs, and nothing else. Anything not listed here
// does not reach the store.
const INCLUDE = [
  "manifest.json",
  "background",
  "content",
  "lib",
  "pages",
  "pdf-viewer",
  "permission",
  "popup",
  "sidepanel",
  "welcome",
  "data",
  "fonts",
  "icons",
  "LICENSE",
  "NOTICE.md"
];

// Belt and braces: even inside an included directory, never ship these.
const EXCLUDE_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const EXCLUDE_EXT = new Set([".md"]); // except NOTICE.md, handled explicitly below

const OUT_DIR = path.join(ROOT, "build");
const STAGE_NAME = `lauxiliaire-${manifest.version}`;
const STAGE = path.join(OUT_DIR, STAGE_NAME);
const ZIP = path.join(OUT_DIR, `${STAGE_NAME}.zip`);

function copyInto(src, dest, { isRoot = false } = {}) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyInto(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  const base = path.basename(src);
  if (EXCLUDE_NAMES.has(base)) return;
  // NOTICE.md is an explicit top-level include; no other .md ships.
  if (!isRoot && EXCLUDE_EXT.has(path.extname(base))) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

// --- stage -----------------------------------------------------------------
fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(STAGE, { recursive: true });

for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) {
    console.error(`MISSING: ${item} — listed in INCLUDE but not in the repo.`);
    process.exit(1);
  }
  copyInto(src, path.join(STAGE, item), { isRoot: true });
}

// --- verify every manifest reference survived the copy ----------------------
const refs = [];
(function collect(o) {
  if (Array.isArray(o)) return o.forEach(collect);
  if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      if (["js", "css", "resources"].includes(k) && Array.isArray(v)) refs.push(...v);
      else if (["service_worker", "default_popup", "default_path"].includes(k) && typeof v === "string") refs.push(v);
      else if (["16", "48", "128"].includes(k) && typeof v === "string") refs.push(v);
      else collect(v);
    }
  }
})(manifest);

const broken = refs.filter((r) => !r.includes("*") && !fs.existsSync(path.join(STAGE, r)));
if (broken.length) {
  console.error("Manifest references missing from the package:");
  broken.forEach((r) => console.error(`  ${r}`));
  process.exit(1);
}

// --- zip -------------------------------------------------------------------
const { zipDir } = require("./lib-zip.js");
const entryCount = zipDir(STAGE, ZIP);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`\nStaged  ${path.relative(ROOT, STAGE)}  (${mb(dirSize(STAGE))}, ${refs.length} manifest refs verified)`);
console.log(`Zipped  ${path.relative(ROOT, ZIP)}  (${mb(fs.statSync(ZIP).size)}, ${entryCount} entries)`);
console.log(`\nBefore uploading, load the STAGED directory unpacked and test it.`);
console.log(`That is the artifact you're submitting; the repo root is not.`);
