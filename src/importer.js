// Import d'un export Notion du journal (zip ou csv) vers la liste de setups utilisée par le scoring.
// Même nettoyage que le dashboard : décimales et dates françaises, liens et émojis retirés,
// copies backtest d'un trade réel retirées, ligne « Test » retirée.
'use strict';
const zlib = require('zlib');

// ---- lecture d'un zip (sans dépendance) -----------------------------------------------------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Archive zip illisible.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    files.push({ name, method, csize, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files.map((f) => ({
    name: f.name,
    read() {
      const nl = buf.readUInt16LE(f.lho + 26), el = buf.readUInt16LE(f.lho + 28);
      const start = f.lho + 30 + nl + el;
      const raw = buf.slice(start, start + f.csize);
      return f.method === 0 ? raw : zlib.inflateRawSync(raw);
    },
  }));
}

// ---- csv -------------------------------------------------------------------------------------
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : r[i]])));
}

// ---- nettoyage -------------------------------------------------------------------------------
const MONTHS = { janvier: 1, 'février': 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, 'août': 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, 'décembre': 12, decembre: 12 };
const WD = { LUNDI: 'Mon', MARDI: 'Tue', MERCREDI: 'Wed', JEUDI: 'Thu', VENDREDI: 'Fri' };
const EMOJI = /[\p{Extended_Pictographic}️‍⃣]/gu;
const clean = (s) => String(s == null ? '' : s)
  .replace(/\s*\(https?:\/\/[^)]*\)/g, '')
  .replace(EMOJI, '')
  .replace(/ /g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const num = (s) => {
  const v = clean(s).replace('%', '').replace(/ /g, '').replace(',', '.');
  if (v === '' || v === '+') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function pdate(s) {
  const m = clean(s).match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (!m || !MONTHS[m[2].toLowerCase()]) return null;
  return String(m[3]).padStart(4, '0') + '-' + String(MONTHS[m[2].toLowerCase()]).padStart(2, '0') + '-' + String(Number(m[1])).padStart(2, '0');
}
const cat = (s) => clean(s).replace(/\s*-\s*Multi Time Frame/, '').trim();

function toTrades(rows) {
  const out = [];
  let skipped = 0;
  rows.forEach((r) => {
    const date = pdate(r['Date']);
    const hour = parseInt(clean(r['Heure']).slice(0, 2), 10);
    const wd = WD[clean(r['Jours Semaine']).split(' ')[0]];
    const ordre = clean(r['Ordre ☑️'] || r['Ordre']);
    const tr = ordre.match(/Tendance de fond : (\S+)/);
    const trend = tr && { 'Haussière': 'Bullish', Neutre: 'Neutral', 'Baissière': 'Bearish' }[tr[1]];
    const R = num(r['Profit : Ratio Gains / Pertes']);
    if (!date || !Number.isFinite(hour) || !wd || !trend || R == null) { skipped++; return; }
    const pair = clean(r['Actif']);
    const [base, quote] = pair.split('/');
    const direction = ordre.startsWith('Achat') ? 'Long' : 'Short';
    let alignment;
    if (trend === 'Neutral') alignment = 'Neutral trend';
    else if ((direction === 'Long' && trend === 'Bullish') || (direction === 'Short' && trend === 'Bearish')) alignment = 'With trend';
    else alignment = 'Counter-trend';
    const tf1raw = clean(r['Unité de temps 1']);
    const tf1 = tf1raw === 'Journalier' ? 'D1' : tf1raw;
    const tf2 = clean(r['Unité de temps 2']);
    const win = Number(r['Win']) === 1, lose = Number(r['Lose']) === 1;
    const sticks = clean(r['Sticks']);
    const tags = sticks.split(',').map((t) => t.trim()).filter(Boolean);
    out.push({
      date, hour, weekday: wd,
      env: clean(r['Environment']),
      pair, base: base || '', quote: quote || '',
      asset_class: /^(XAU|XAG)/.test(pair) ? 'Metals' : 'FX',
      direction, trend, alignment,
      trendline: clean(r['Structure 1 📊'] || r['Structure 1']).includes('haussière') ? 'Up' : 'Down',
      pattern: cat(r['Structure 2 📊'] || r['Structure 2']),
      tf1, tf2, tf_combo: tf1 + ' / ' + tf2,
      result: clean(r['Résultat']), outcome: win ? 'Win' : lose ? 'Loss' : 'BE',
      r: R, pct: num(r['Pourcentage du capital']), mfe: num(r['MFE']), mae: num(r['MAE']), duration_h: num(r['Durée du trade en Heures']),
      lt_category: clean(r['Catégorie de la LT']), lt_impacts: clean(r["Nombre d'impact sur la LT"]), lt_slope: clean(r["Type d'inclinaison de la LT"]),
      lt_fan: clean(r['Eventail de la LT']),
      entry_line: tags.includes('ON LINE') ? 'ON LINE' : tags.includes('OUT LINE') ? 'OUT LINE' : '',
      tags: tags.join(' | '),
      move_after: clean(r['move After Entry']),
      conviction: clean(r['Conviction']), emotion: clean(r['État émotionnel']), plan: clean(r['Respect du plan']),
      mistake: String(r['My mistake'] || '').trim(), lesson: String(r['Leçon/remarque'] || '').trim(),
      week_of_month: clean(r['n° week (auto)']).replace('week ', 'W'),
      label: clean(r['Actif financier']),
    });
  });
  return { trades: out, skipped };
}

// Retire les copies backtest d'un trade réel et la ligne de test ; marque chaque setup « Pris » ou « Manqué ».
function build(rows) {
  const { trades, skipped } = toTrades(rows);
  const key = (x) => [x.date, x.pair, x.direction, x.pattern].join('|');
  const real = new Set(trades.filter((x) => x.env === 'Réel').map(key));
  let doublons = 0, tests = 0;
  const kept = [];
  trades.forEach((x) => {
    if (x.env === 'Test') { tests++; return; }
    if (x.env === 'Backtest' && real.has(key(x))) { doublons++; return; }
    kept.push({ ...x, statut: x.env === 'Réel' ? 'Pris' : 'Manqué' });
  });
  kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.hour - b.hour));
  kept.forEach((x, i) => { x.id = 't' + String(i + 1).padStart(3, '0'); });
  return {
    trades: kept,
    summary: { total: kept.length, pris: kept.filter((x) => x.statut === 'Pris').length, manques: kept.filter((x) => x.statut === 'Manqué').length, doublons, tests, ignores: skipped },
  };
}

// buf : contenu d'un .zip ou d'un .csv de l'export Notion.
function importFile(buf, name) {
  let csv;
  if (/\.zip$/i.test(name) || buf.readUInt32LE(0) === 0x04034b50) {
    const files = readZip(buf).filter((f) => /\.csv$/i.test(f.name));
    if (!files.length) throw new Error('Aucun fichier .csv dans cette archive.');
    const full = files.find((f) => /_all\.csv$/i.test(f.name)) || files[0];
    csv = full.read().toString('utf8');
  } else {
    csv = buf.toString('utf8');
  }
  const rows = parseCsv(csv);
  if (!rows.length || !('Profit : Ratio Gains / Pertes' in rows[0])) throw new Error('Ce fichier ne ressemble pas à l’export du journal (colonne « Profit : Ratio Gains / Pertes » introuvable).');
  return build(rows);
}

module.exports = { importFile, readZip, parseCsv, build };
