// Redessine le logo (cœur en pixels rouges avec halo) sans dépendance : build/icon.png et build/tray.png.
// L'image d'origine n'ayant pas été accessible sur le disque, la grille 9×9 est reconstituée à l'identique.
// Pour utiliser le fichier original : l'enregistrer en build/logo.png puis `npm run logo:file`.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// D = contour sombre, d = creux foncé, R = rouge vif, r = rouge plus sombre (bas du cœur)
const GRID = [
  '..DD.DD..',
  '.DRRDRRD.',
  'DRdRRRdRD',
  'DRddRddRD',
  'DrRdRdRrD',
  '.DrRRRrD.',
  '..DrRrD..',
  '...DrD...',
  '....D....',
];
const COLORS = { D: [122, 10, 10], d: [172, 14, 14], R: [255, 28, 20], r: [226, 18, 16] };

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(rgba, S) {
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// flou en boîte séparable, plusieurs passes ≈ gaussien
function blur(a, S, radius, passes) {
  let src = Float32Array.from(a), dst = new Float32Array(S * S);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < S; y++) {
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += src[y * S + Math.min(S - 1, Math.max(0, x))];
      for (let x = 0; x < S; x++) {
        dst[y * S + x] = sum / (2 * radius + 1);
        sum += src[y * S + Math.min(S - 1, x + radius + 1)] - src[y * S + Math.max(0, x - radius)];
      }
    }
    [src, dst] = [dst, src];
    for (let x = 0; x < S; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += src[Math.min(S - 1, Math.max(0, y)) * S + x];
      for (let y = 0; y < S; y++) {
        dst[y * S + x] = sum / (2 * radius + 1);
        sum += src[Math.min(S - 1, y + radius + 1) * S + x] - src[Math.max(0, y - radius) * S + x];
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

function render(S, onWhite) {
  const cell = Math.floor((S * 0.72) / 9);           // le cœur occupe ~74 % de la largeur : rognage serré
  const size = cell * 9;
  const ox = Math.round((S - size) / 2), oy = Math.round((S - size) / 2 + cell * 0.1);
  const mask = new Float32Array(S * S);
  const color = new Uint8Array(S * S * 3);
  GRID.forEach((row, gy) => [...row].forEach((ch, gx) => {
    if (ch === '.') return;
    const c = COLORS[ch];
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const px = ox + gx * cell + x, py = oy + gy * cell + y;
      const i = py * S + px;
      mask[i] = 1;
      // léger dégradé vertical : le haut de chaque case est un peu plus clair
      const k = 1 + 0.07 * (1 - y / cell) - 0.04 * (y / cell);
      color[i * 3] = Math.min(255, c[0] * k); color[i * 3 + 1] = Math.min(255, c[1] * k); color[i * 3 + 2] = Math.min(255, c[2] * k);
    }
  }));
  const glow = blur(mask, S, Math.max(2, Math.round(cell * 0.42)), 3);
  const out = Buffer.alloc(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const g = Math.min(1, glow[i] * 1.5) * 0.42;       // halo rouge
    let r, gC, b, a;
    if (mask[i] > 0) { r = color[i * 3]; gC = color[i * 3 + 1]; b = color[i * 3 + 2]; a = 255; }
    else if (onWhite) { r = 255; gC = 255 - 215 * g; b = 255 - 215 * g; a = 255; r = 255 - 25 * g; }
    else { r = 255; gC = 40; b = 30; a = Math.round(g * 255); }
    out[i * 4] = r; out[i * 4 + 1] = gC; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
  }
  return out;
}

const dir = path.join(__dirname, '..', 'build');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), png(render(512, false), 512));
fs.writeFileSync(path.join(dir, 'tray.png'), png(render(32, false), 32));
fs.writeFileSync(path.join(dir, 'logo-redraw-white.png'), png(render(512, true), 512));
console.log('build/icon.png, build/tray.png, build/logo-redraw-white.png écrits');
