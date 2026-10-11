// Prépare l'icône à partir de l'image d'origine : retire le fond blanc (halo conservé en transparence),
// rogne serré autour du cœur, centre dans un carré et écrit build/icon.png (512) et build/tray.png (32).
// Usage : npm run logo:file            (lit build/logo.png)
//         npx electron tools/logo-from-file.js chemin/vers/image.png
'use strict';
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const src = path.resolve(process.argv[2] || path.join(__dirname, '..', 'build', 'logo.png'));
  if (!fs.existsSync(src)) { console.error('Image introuvable : ' + src); app.exit(1); return; }
  const img = nativeImage.createFromPath(src);
  if (img.isEmpty()) { console.error('Image illisible : ' + src); app.exit(1); return; }
  const { width: w, height: h } = img.getSize();
  const bmp = Buffer.from(img.toBitmap()); // BGRA
  // Couleur vers alpha depuis le blanc : un pixel clair devient transparent, le rouge garde son intensité.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const B = bmp[i], G = bmp[i + 1], R = bmp[i + 2];
      const a = 255 - Math.min(R, G, B);
      if (a <= 0) { bmp[i] = bmp[i + 1] = bmp[i + 2] = bmp[i + 3] = 0; continue; }
      const un = (c) => Math.max(0, Math.min(255, 255 - ((255 - c) * 255) / a));
      bmp[i] = un(B); bmp[i + 1] = un(G); bmp[i + 2] = un(R); bmp[i + 3] = a;
      if (a > 200) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) { console.error('Aucun contenu visible dans l’image.'); app.exit(1); return; }
  const side = Math.round(Math.max(x1 - x0 + 1, y1 - y0 + 1) * 1.34); // marge pour le halo
  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
  const sx = Math.round(cx - side / 2), sy = Math.round(cy - side / 2);
  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const px = sx + x, py = sy + y;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      bmp.copy(out, (y * side + x) * 4, (py * w + px) * 4, (py * w + px) * 4 + 4);
    }
  }
  const square = nativeImage.createFromBitmap(out, { width: side, height: side });
  const dir = path.join(__dirname, '..', 'build');
  fs.writeFileSync(path.join(dir, 'icon.png'), square.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
  fs.writeFileSync(path.join(dir, 'tray.png'), square.resize({ width: 32, height: 32, quality: 'best' }).toPNG());
  console.log('build/icon.png et build/tray.png écrits (zone du cœur : ' + (x1 - x0 + 1) + '×' + (y1 - y0 + 1) + ' px sur ' + w + '×' + h + ')');
  app.exit(0);
});
