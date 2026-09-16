/**
 * Syntax guard. Run: node scripts/check-syntax.js
 *
 * Parses every first-party JS file and reports anything that doesn't.
 *
 * The reason this needs a script rather than a shell one-liner: `node --check`
 * decides CommonJS vs ES module from the file EXTENSION, and every module in
 * this repo is a `.js`. So `node --check lib/tour.js` parses an ES module as
 * CommonJS and fails on the first `export` with "Unexpected token 'export'" —
 * a false alarm that trains you to ignore the checker. This copies ES modules
 * to a temporary `.mjs` first, which is the only way to get `--check` to apply
 * module grammar.
 *
 * Deliberately NOT a package.json `"type": "module"` fix: the build scripts in
 * this same folder are CommonJS (`require`), so flipping the whole package
 * would break them instead. The two dialects genuinely coexist here.
 *
 * Skips pdf-viewer/vendor/ — upstream PDF.js is not ours to police, and it's
 * ~285 files.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "Lexique4"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith(".js")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// An `import`/`export` at the start of a line is the tell. Checking only at
// line starts avoids matching the words inside a comment or a string, which a
// bare /import/ would do constantly in a codebase that talks about modules.
const ESM_RE = /^\s*(?:import\s|export\s|import\(|export\{)/m;

function isModule(source) {
  return ESM_RE.test(source);
}

const files = walk(ROOT).sort();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fla-syntax-"));
const failures = [];
let moduleCount = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const source = fs.readFileSync(file, "utf8");
  let target = file;

  if (isModule(source)) {
    moduleCount++;
    // Flatten the path into the filename so two files with the same basename
    // in different folders can't overwrite each other.
    target = path.join(tmpDir, `${rel.replace(/[/\\]/g, "__")}.mjs`);
    fs.writeFileSync(target, source);
  }

  try {
    execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
  } catch (err) {
    const detail = String(err.stderr || err.message)
      .split("\n")
      .filter((l) => l.trim() && !l.includes(tmpDir))
      .slice(0, 4)
      .join("\n    ");
    failures.push(`  ${rel}\n    ${detail}`);
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(
  `Checked ${files.length} files (${moduleCount} ES modules, ${files.length - moduleCount} CommonJS).`
);

if (failures.length) {
  console.error(`\n${failures.length} file(s) failed to parse:\n`);
  console.error(failures.join("\n\n"));
  process.exit(1);
}

console.log("All files parse.");
