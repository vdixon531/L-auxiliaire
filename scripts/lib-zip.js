/**
 * Minimal ZIP writer. Used by scripts/package.js.
 *
 * Hand-rolled rather than shelled out to the platform, because the obvious
 * shortcuts are both wrong here:
 *
 *  - PowerShell's Compress-Archive (Windows PowerShell 5.1) writes entry names
 *    with BACKSLASH separators. The ZIP spec (APPNOTE 4.4.17.1) requires
 *    forward slashes, and tools that take it literally see one flat file
 *    called "background\cache.js" rather than a directory tree. Not something
 *    to discover from a store rejection.
 *  - `zip` isn't present on Windows by default, so it can't be the only path.
 *
 * Writes deflated entries with a correct central directory. No ZIP64, no
 * encryption, no multi-disk — none of which a browser extension needs.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Standard CRC-32 (IEEE 802.3), table built once.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** DOS date/time, the format ZIP stores. Pre-1980 clamps to the epoch. */
function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    // Forward slashes, always — see the header note.
    else out.push({ full, name: path.relative(base, full).split(path.sep).join("/") });
  }
  return out;
}

/**
 * Zip every file under `srcDir` into `zipPath`, with `srcDir` itself as the
 * archive root (so manifest.json lands at the top level, which is what Chrome
 * requires). Returns the entry count.
 */
function zipDir(srcDir, zipPath) {
  const files = walk(srcDir);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // A tiny file can deflate larger than it started; store it raw if so.
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosTime(fs.statSync(f.full).mtime);
    const crc = crc32(data);
    const nameBuf = Buffer.from(f.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, payload);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central directory signature
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comment
    cen.writeUInt16LE(0, 34); // disk number
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0o644 << 16, 38); // external attrs: regular file, rw-r--r--
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  fs.writeFileSync(zipPath, Buffer.concat([...locals, centralBuf, end]));
  return files.length;
}

module.exports = { zipDir };
