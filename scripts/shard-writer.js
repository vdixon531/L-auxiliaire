// shard-writer.js
// Shared build-time helpers for sharding a dataset by normalized first letter
// and writing it to data/<name>/<letter>.json. Used by build-verbiste.js and
// build-lexicon.js. background/conjugation.js and background/lexicon.js keep
// their own small copies of normalize()/shardKeyOf() (they run in the service
// worker's ES-module context, not Node) — all copies must match exactly, or a
// word looks up a shard that was never built for it.

const fs = require("fs");
const path = require("path");

function normalize(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function shardKeyOf(normalized) {
  return /^[a-z]/.test(normalized) ? normalized[0] : "_other";
}

function writeSharded(dir, buckets) {
  fs.mkdirSync(dir, { recursive: true });
  // Clear stale shards from a previous run in case the dataset shrank.
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f));
  }
  for (const [key, obj] of Object.entries(buckets)) {
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(obj));
  }
  return Object.keys(buckets).length;
}

module.exports = { normalize, shardKeyOf, writeSharded };
