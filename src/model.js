// Modèle de scoring : régression ridge du R de chaque trade sur les champs connus à l'entrée.
// Chaque champ ajouté fait bouger l'estimation, les champs qui se recoupent ne sont pas comptés deux fois
// et les catégories à faible échantillon sont ramenées vers la moyenne au lieu d'être crues.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Model = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LAMBDA = 20; // force du lissage, en « trades »
  const CAP_LO = -2, CAP_HI = 6; // R borné pour qu'un trade hors norme ne tire pas une catégorie
  const SCALE = 0.6; // R au-dessus de la moyenne correspondant à ~88 points
  const STRONG = 65, MID = 40;

  const FIELDS = [
    { id: 'pattern', label: 'Structure 2' },
    { id: 'trendline', label: 'Ligne de tendance' },
    { id: 'trend', label: 'Tendance de fond' },
    { id: 'direction', label: 'Direction' },
    { id: 'tf1', label: 'Unité de temps 1' },
    { id: 'tf2', label: 'Unité de temps 2' },
    { id: 'pair', label: 'Paire' },
    { id: 'weekday', label: 'Jour' },
    { id: 'hour', label: 'Heure d’entrée' },
    { id: 'lt_slope', label: 'Pente de la LT' },
    { id: 'lt_impacts', label: 'Touches sur la LT' },
    { id: 'entry_line', label: 'Entrée / ligne' },
  ];
  const AUTO = [
    { id: 'alignment', label: 'Alignement' },
    { id: 'tf_combo', label: 'Couple d’UT' },
    { id: 'quote', label: 'Devise de cotation' },
  ];
  const FR = {
    trendline: { Up: 'Haussière', Down: 'Baissière' },
    trend: { Bullish: 'Haussière', Neutral: 'Neutre', Bearish: 'Baissière' },
    direction: { Long: 'Achat', Short: 'Vente' },
    weekday: { Mon: 'Lundi', Tue: 'Mardi', Wed: 'Mercredi', Thu: 'Jeudi', Fri: 'Vendredi' },
    alignment: { 'With trend': 'Avec la tendance', 'Neutral trend': 'Tendance neutre', 'Counter-trend': 'Contre-tendance' },
    tf1: { D1: 'Journalier' },
  };
  const ORDER = {
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    tf1: ['M90', 'H1', 'H2', 'H3', 'H4', 'H8', 'H12', 'D1'],
    tf2: ['M10', 'M15', 'M30', 'M45', 'H1', 'H2'],
    trend: ['Bullish', 'Neutral', 'Bearish'],
    lt_impacts: ['2', '3', '4', '5', '+6'],
    direction: ['Long', 'Short'],
    trendline: ['Up', 'Down'],
  };
  const NUMERIC = new Set(['hour']);
  const showVal = (d, v) => {
    if (FR[d] && FR[d][v]) return FR[d][v];
    if (d === 'hour') return v.padStart(2, '0') + ':00';
    if (d === 'lt_slope') return 'Type ' + v;
    if (d === 'lt_impacts') return v + ' touches';
    return v;
  };
  const labelOf = (d) => (FIELDS.find((x) => x.id === d) || AUTO.find((x) => x.id === d) || { label: d }).label;
  const isAuto = (d) => !FIELDS.some((f) => f.id === d);
  const get = (t, d) => {
    const v = d === 'hour' ? (t.hour == null ? null : String(t.hour)) : t[d];
    return v == null || v === '' ? null : String(v);
  };

  // ---- modèle ---------------------------------------------------------------------
  const cholSolve = (A, p, rhs) => {
    for (let j = 0; j < p; j++) {
      let s = A[j * p + j];
      for (let k = 0; k < j; k++) s -= A[j * p + k] * A[j * p + k];
      const d = Math.sqrt(Math.max(s, 1e-9));
      A[j * p + j] = d;
      for (let i = j + 1; i < p; i++) {
        let t = A[i * p + j];
        for (let k = 0; k < j; k++) t -= A[i * p + k] * A[j * p + k];
        A[i * p + j] = t / d;
      }
    }
    return rhs.map((b) => {
      const y = new Float64Array(p), x = new Float64Array(p);
      for (let i = 0; i < p; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= A[i * p + k] * y[k];
        y[i] = s / A[i * p + i];
      }
      for (let i = p - 1; i >= 0; i--) {
        let s = y[i];
        for (let k = i + 1; k < p; k++) s -= A[k * p + i] * x[k];
        x[i] = s / A[i * p + i];
      }
      return x;
    });
  };

  function fit(trades) {
    const dims = [...FIELDS.map((f) => f.id), ...AUTO.map((a) => a.id), 'statut'];
    const blocks = {}, cols = [];
    dims.forEach((d) => {
      const counts = new Map();
      let known = 0;
      trades.forEach((t) => { const v = get(t, d); if (v != null) { counts.set(v, (counts.get(v) || 0) + 1); known += 1; } });
      const bc = [...counts.keys()].map((v) => {
        const c = { dim: d, value: v, n: counts.get(v), mean: counts.get(v) / known, idx: cols.length };
        cols.push(c);
        return c;
      });
      blocks[d] = { dim: d, known, cols: bc, index: new Map(bc.map((c) => [c.value, c])) };
    });
    const n = trades.length, p = cols.length;
    const X = new Float64Array(n * p);
    trades.forEach((t, i) => {
      dims.forEach((d) => {
        const v = get(t, d);
        if (v == null) return;
        blocks[d].cols.forEach((c) => { X[i * p + c.idx] = (c.value === v ? 1 : 0) - c.mean; });
      });
    });
    const yR = trades.map((t) => Math.max(CAP_LO, Math.min(CAP_HI, t.r)));
    const yW = trades.map((t) => (t.outcome === 'Win' ? 1 : 0));
    const ybar = yR.reduce((s, x) => s + x, 0) / n, wbar = yW.reduce((s, x) => s + x, 0) / n;
    const A = new Float64Array(p * p), bR = new Float64Array(p), bW = new Float64Array(p);
    for (let i = 0; i < n; i++) {
      const row = i * p, dr = yR[i] - ybar, dw = yW[i] - wbar;
      for (let a = 0; a < p; a++) {
        const xa = X[row + a];
        if (xa === 0) continue;
        bR[a] += xa * dr;
        bW[a] += xa * dw;
        for (let b = 0; b <= a; b++) A[a * p + b] += xa * X[row + b];
      }
    }
    for (let a = 0; a < p; a++) A[a * p + a] += LAMBDA;
    const [betaR, betaW] = cholSolve(A, p, [bR, bW]);
    return { n, p, blocks, cols, ybar, wbar, betaR, betaW, key: n + '|' + (trades[0] && trades[0].id) + '|' + (trades[n - 1] && trades[n - 1].id) };
  }

  // Fiabilité : le modèle prédit-il les trades qu'il n'a pas vus ? (validation croisée 5 blocs, 2 tirages)
  function reliability(trades) {
    const folds = 5, pairs = [];
    for (let s = 0; s < 2; s++) {
      let x = 4242 + s * 7919;
      const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
      const idx = trades.map((_, i) => i).sort(() => rnd() - 0.5);
      for (let f = 0; f < folds; f++) {
        const train = idx.filter((_, k) => k % folds !== f).map((i) => trades[i]);
        const test = idx.filter((_, k) => k % folds === f).map((i) => trades[i]);
        const m = fit(train);
        test.forEach((t) => {
          const o = {};
          FIELDS.forEach((fl) => { const v = get(t, fl.id); if (v != null) o[fl.id] = v; });
          pairs.push([predict(m, o).E - m.ybar, Math.max(CAP_LO, Math.min(CAP_HI, t.r)) - m.ybar]);
        });
      }
    }
    const n = pairs.length;
    const sxx = pairs.reduce((a, [p]) => a + p * p, 0), sxy = pairs.reduce((a, [p, y]) => a + p * y, 0);
    const mp = pairs.reduce((a, [p]) => a + p, 0) / n, my = pairs.reduce((a, [, y]) => a + y, 0) / n;
    let c = 0, vp = 0, vy = 0;
    pairs.forEach(([p, y]) => { c += (p - mp) * (y - my); vp += (p - mp) ** 2; vy += (y - my) ** 2; });
    return { slope: sxx ? sxy / sxx : 0, corr: vp && vy ? c / Math.sqrt(vp * vy) : 0, n };
  }

  const withAuto = (sel) => {
    const f = { ...sel };
    if (sel.direction && sel.trend) {
      const up = sel.trend === 'Bullish', dn = sel.trend === 'Bearish';
      f.alignment = sel.trend === 'Neutral' ? 'Neutral trend' : (sel.direction === 'Long' && up) || (sel.direction === 'Short' && dn) ? 'With trend' : 'Counter-trend';
    }
    if (sel.tf1 && sel.tf2) f.tf_combo = sel.tf1 + ' / ' + sel.tf2;
    if (sel.pair && sel.pair.includes('/')) f.quote = sel.pair.split('/')[1];
    return f;
  };

  function predict(model, sel) {
    const full = withAuto(sel);
    const k = model.shrink == null ? 1 : model.shrink;
    let E = model.ybar, W = model.wbar;
    const parts = [];
    Object.entries(full).forEach(([d, v]) => {
      const blk = model.blocks[d];
      if (!blk || !blk.index.has(v)) { parts.push({ dim: d, value: v, r: 0, w: 0, n: 0, unseen: true, auto: isAuto(d) }); return; }
      let eR = 0, eW = 0;
      blk.cols.forEach((c) => {
        const x = (c.value === v ? 1 : 0) - c.mean;
        eR += model.betaR[c.idx] * x;
        eW += model.betaW[c.idx] * x;
      });
      E += k * eR;
      W += k * eW;
      parts.push({ dim: d, value: v, r: k * eR, w: k * eW, n: blk.index.get(v).n, auto: isAuto(d) });
    });
    let score = 50 + 50 * Math.tanh((E - model.ybar) / SCALE);
    if (E <= 0) score = Math.min(score, MID - 1);
    return { E, W: Math.max(0.02, Math.min(0.98, W)), score: Math.round(score), parts };
  }
  const tierOf = (s) => (s >= STRONG ? 'strong' : s >= MID ? 'mid' : 'weak');
  const TIER_LABEL = { strong: 'FORT', mid: 'MOYEN', weak: 'FAIBLE' };


  const sortedValues = (blk, d) => {
    const vals = blk.cols.map((c) => c.value);
    if (ORDER[d]) return vals.sort((a, b) => (ORDER[d].indexOf(a) + 1 || 99) - (ORDER[d].indexOf(b) + 1 || 99));
    if (NUMERIC.has(d)) return vals.sort((a, b) => Number(a) - Number(b));
    if (d === 'pattern') return vals.sort((a, b) => blk.index.get(b).n - blk.index.get(a).n);
    return vals.sort((a, b) => a.localeCompare(b));
  };

  return {
    FIELDS, AUTO, FR, ORDER, NUMERIC, STRONG, MID, TIER_LABEL, CAP_LO, CAP_HI,
    showVal, labelOf, isAuto, get, fit, reliability, withAuto, predict, tierOf, sortedValues,
  };
});
