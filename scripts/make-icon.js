'use strict';

/**
 * Generates assets/icon.png without any image dependency.
 * Draws the SaraText mark: a rounded dark tile with a folded-corner page.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const S = 256;
const px = Buffer.alloc(S * S * 4);

const BG = [0x1b, 0x1d, 0x23];
const ACCENT = [0x7a, 0xa2, 0xf7];
const PAGE = [0xe6, 0xe8, 0xee];
const TEXT = [0x9a, 0xa1, 0xb0];

function put(x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const na = a / 255;
  const ba = px[i + 3] / 255;
  const out = na + ba * (1 - na);
  if (out === 0) return;
  for (let c = 0; c < 3; c++) {
    px[i + c] = Math.round((rgb[c] * na + px[i + c] * ba * (1 - na)) / out);
  }
  px[i + 3] = Math.round(out * 255);
}

function roundRect(x0, y0, x1, y1, r, rgb, a) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
      const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) put(x, y, rgb, a);
    }
  }
}

// tile
roundRect(0, 0, S - 1, S - 1, 48, BG, 255);
roundRect(1, 1, S - 2, S - 2, 47, ACCENT, 26);
roundRect(2, 2, S - 3, S - 3, 46, BG, 255);

// page
const x0 = 68;
const y0 = 44;
const x1 = 188;
const y1 = 212;
roundRect(x0, y0, x1, y1, 10, PAGE, 255);

// folded corner
for (let y = 0; y < 34; y++) {
  for (let x = 0; x < 34 - y; x++) {
    put(x1 - 34 + x + 1, y0 + y + 1, ACCENT, 235);
  }
}

// text rules
for (let i = 0; i < 4; i++) {
  const y = 116 + i * 24;
  const w = i === 3 ? 60 : 84;
  roundRect(88, y, 88 + w, y + 7, 3.5, TEXT, 255);
}

// PNG encode
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${S}x${S})`);
