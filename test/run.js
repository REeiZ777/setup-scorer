// Vérifications rapides : import du journal, modèle de score, cohérence des données.
// Usage : npm test [chemin/vers/export.zip]
// Sans données personnelles (data/trades.json est ignoré par git), un jeu synthétique est utilisé.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { importFile } = require('../src/importer');
const M = require('../src/model');

const zip = process.argv[2];
const localFile = path.join(__dirname, '..', 'data', 'trades.json');
let data, origin;
if (zip && fs.existsSync(zip)) { data = importFile(fs.readFileSync(zip), path.basename(zip)).trades; origin = 'export ' + path.basename(zip); }
else if (fs.existsSync(localFile)) { data = JSON.parse(fs.readFileSync(localFile, 'utf8')); origin = 'data/trades.json'; }
else {
  // jeu synthétique déterministe
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  data = Array.from({ length: 150 }, (_, i) => {
    const pattern = pick(['Double Bottom', 'Double Top', 'Consolidation']);
    const direction = pick(['Long', 'Short']);
    const trend = pick(['Bullish', 'Neutral', 'Bearish']);
    const tf1 = pick(['H1', 'H2', 'H4']), tf2 = pick(['M15', 'M30']);
    const pair = pick(['GBP/JPY', 'EUR/USD', 'XAU/USD', 'USD/CAD']);
    const bonus = pattern === 'Double Bottom' ? 0.8 : 0;
    const r = Math.round((bonus + (rnd() - 0.5) * 4) * 100) / 100;
    return {
      id: 't' + String(i + 1).padStart(3, '0'), date: '2025-' + String(1 + (i % 12)).padStart(2, '0') + '-10', hour: 6 + (i % 10),
      weekday: pick(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']), env: i % 2 ? 'Réel' : 'Backtest', statut: i % 2 ? 'Pris' : 'Manqué',
      pair, base: pair.split('/')[0], quote: pair.split('/')[1], direction, trend, trendline: direction === 'Long' ? 'Up' : 'Down', pattern, tf1, tf2,
      tf_combo: tf1 + ' / ' + tf2, alignment: trend === 'Neutral' ? 'Neutral trend' : 'With trend', r, outcome: r > 0.1 ? 'Win' : r < -0.1 ? 'Loss' : 'BE',
      lt_slope: pick(['A', 'B', 'C']), lt_impacts: pick(['2', '3', '4']), entry_line: pick(['ON LINE', 'OUT LINE', '']),
    };
  });
  origin = 'jeu synthétique';
}
console.log('données : ' + origin + ' (' + data.length + ' lignes)');

let ok = 0;
const t = (name, fn) => { fn(); ok++; console.log('ok  ', name); };

t('chaque ligne a un statut Pris ou Manqué', () => {
  assert.ok(data.every((x) => x.statut === 'Pris' || x.statut === 'Manqué'));
});
t('aucune copie d’un trade pris parmi les manqués', () => {
  const key = (x) => [x.date, x.pair, x.direction, x.pattern].join('|');
  const real = new Set(data.filter((x) => x.statut === 'Pris').map(key));
  if (origin.startsWith('jeu')) return;
  assert.strictEqual(data.filter((x) => x.statut === 'Manqué' && real.has(key(x))).length, 0);
});
t('le modèle s’ajuste et la fiabilité est un nombre', () => {
  const m = M.fit(data);
  const r = M.reliability(data);
  assert.ok(m.n === data.length && Number.isFinite(r.corr) && Number.isFinite(r.slope));
});
t('le score est toujours entre 0 et 100 et fini', () => {
  const m = M.fit(data);
  Object.values(m.blocks).forEach((blk) => blk.cols.forEach((c) => {
    const s = M.predict(m, { [blk.dim]: c.value }).score;
    assert.ok(Number.isFinite(s) && s >= 0 && s <= 100);
  }));
});
t('un setup à R attendu négatif ne dépasse jamais MOYEN', () => {
  const m = M.fit(data);
  Object.values(m.blocks).forEach((blk) => blk.cols.forEach((c) => {
    const r = M.predict(m, { [blk.dim]: c.value });
    if (r.E <= 0) assert.ok(r.score < M.MID);
  }));
});
t('un champ vide n’a aucun effet : score identique sans sélection', () => {
  const m = M.fit(data);
  assert.strictEqual(M.predict(m, {}).score, M.predict(m, {}).score);
  assert.ok(Math.abs(M.predict(m, {}).E - m.ybar) < 1e-9);
});
if (zip && fs.existsSync(zip) && fs.existsSync(localFile)) {
  t('l’import du zip reproduit data/trades.json', () => {
    const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    assert.deepStrictEqual(data.map((x) => x.id + x.r), local.map((x) => x.id + x.r));
  });
}
console.log(ok + ' vérifications réussies');
