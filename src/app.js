// Interface du popup : saisie du setup, score, impact des champs, setups suivis, fiabilité et données.
'use strict';
(() => {
  const M = window.Model;
  const $ = (s, r) => (r || document).querySelector(s);
  const ce = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const tf = (v, d) => v.toFixed(d).replace('.', ',');
  const fR = (v, d = 2) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + tf(Math.abs(v), d) + 'R');
  const fP = (v) => Math.round(v * 100) + ' %';
  const TIER_SUB = {
    strong: 'Fait mieux que ta moyenne',
    mid: 'Dans ta moyenne, pas d’avantage net',
    weak: 'Fait moins bien que ton historique',
    none: 'Choisis des champs ci-dessous',
  };

  // ---- accès aux données : Electron, ou un stockage local pour tester dans un navigateur -----------
  const devApi = {
    async load() {
      const trades = await (await fetch('../data/trades.json')).json();
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('dev-settings') || '{}'); } catch (e) { /* ignoré */ }
      return { settings: { pinned: true, mode: 'prudent', period: 'all', open: {}, setups: [], ...saved }, trades, meta: { source: 'bundled', name: 'Données intégrées', importedAt: null, summary: null }, shortcut: 'Ctrl+Alt+S', version: 'dev' };
    },
    async save(p) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('dev-settings') || '{}'); } catch (e) { /* ignoré */ }
      try { localStorage.setItem('dev-settings', JSON.stringify({ ...saved, ...p })); } catch (e) { /* ignoré */ }
      return true;
    },
    pin: async (on) => on,
    minimize() {},
    hide() {},
    importData: async () => ({ canceled: true }),
    resetData: async () => ({ trades: [], meta: null }),
  };
  const api = window.api || devApi;

  // ---- état ---------------------------------------------------------------------------------------------
  const st = { all: [], meta: null, period: 'all', mode: 'prudent', open: {}, setups: [], pinned: true, model: null, trades: [], watchOpen: new Set(), shortcut: 'Ctrl+Alt+S' };
  const FIELDS = M.FIELDS;
  const saveSoon = (() => { let t; return (p) => { clearTimeout(t); t = setTimeout(() => api.save(p), 150); }; })();

  function byPeriod(trades, period) {
    if (period === 'all' || !trades.length) return trades;
    if (period === 'y2026' || period === 'y2025') return trades.filter((t) => t.date.startsWith(period.slice(1)));
    const last = trades.reduce((m, t) => (t.date > m ? t.date : m), '0000');
    const d = new Date(last + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - (period === '12m' ? 12 : 6));
    const from = d.toISOString().slice(0, 10);
    return trades.filter((t) => t.date > from);
  }

  function refit() {
    st.trades = byPeriod(st.all, st.period);
    if (st.trades.length < 20) { st.model = null; return; }
    const m = M.fit(st.trades);
    m.rel = M.reliability(st.trades);
    st.model = m;
    applyMode();
  }
  function applyMode() {
    if (st.model) st.model.shrink = st.mode === 'prudent' ? Math.max(0.2, Math.min(1, st.model.rel.slope)) : 1;
  }

  // ---- formulaire ---------------------------------------------------------------------------------------------
  function buildFields() {
    const host = $('#fields');
    host.replaceChildren();
    FIELDS.forEach((f) => {
      const l = ce('label', 'cell');
      l.appendChild(ce('span', '', f.label));
      const s = ce('select');
      s.id = 'f-' + f.id;
      s.addEventListener('change', refresh);
      l.appendChild(s);
      host.appendChild(l);
    });
  }
  function fillOptions(extra) {
    FIELDS.forEach((f) => {
      const s = $('#f-' + f.id);
      const keep = (extra && extra[f.id]) || s.value;
      const blk = st.model && st.model.blocks[f.id];
      const vals = blk ? M.sortedValues(blk, f.id) : [];
      if (keep && !vals.includes(keep)) vals.push(keep);
      s.replaceChildren(new Option('— indifférent —', ''));
      vals.forEach((v) => s.appendChild(new Option(M.showVal(f.id, v) + (blk && blk.index.has(v) ? '  (' + blk.index.get(v).n + ')' : '  (aucun historique)'), v)));
      s.value = keep || '';
    });
  }
  const sel = () => {
    const o = {};
    FIELDS.forEach((f) => { const v = $('#f-' + f.id).value; if (v) o[f.id] = v; });
    return o;
  };

  // ---- calculs de présentation -----------------------------------------------------------------------------------
  function exactMatch(s) {
    const keys = Object.entries(s);
    const rows = keys.length ? st.trades.filter((t) => keys.every(([d, v]) => M.get(t, d) === v)) : [];
    const avg = (a) => (a.length ? a.reduce((x, t) => x + t.r, 0) / a.length : null);
    return {
      n: rows.length, wins: rows.filter((t) => t.outcome === 'Win').length, avg: avg(rows),
      pris: { n: rows.filter((t) => t.statut === 'Pris').length, avg: avg(rows.filter((t) => t.statut === 'Pris')) },
      manques: { n: rows.filter((t) => t.statut === 'Manqué').length, avg: avg(rows.filter((t) => t.statut === 'Manqué')) },
    };
  }
  function confidence(parts, exact) {
    const real = parts.filter((x) => !x.auto);
    const m = real.length;
    const minN = m ? Math.min(...real.map((x) => x.n)) : 0;
    if (m === 0) return { level: 0, text: 'Choisis un champ' };
    if (m < 2 || minN < 8) return { level: 1, text: m < 2 ? 'Ajoute des champs' : 'Un champ repose sur < 8 trades' };
    if (m >= 3 && minN >= 15 && exact.n >= 5) return { level: 3, text: 'Échantillon solide' };
    return { level: 2, text: exact.n < 5 ? 'Peu de trades identiques' : 'Échantillon correct' };
  }

  // ---- rendu principal --------------------------------------------------------------------------------------------------
  function refresh() {
    const m = st.model;
    const app = $('#app');
    if (!m) {
      app.dataset.tier = 'none';
      $('#score').textContent = '––';
      $('#tier').textContent = st.all.length ? 'DONNÉES INSUFFISANTES' : 'AUCUNE DONNÉE';
      $('#tierSub').textContent = st.all.length ? 'Moins de 20 setups sur cette période' : 'Importe ton journal pour commencer';
      $('#kv').replaceChildren();
      $('#ident').textContent = '';
      $('#hint').textContent = '';
      $('#mods').replaceChildren(ce('p', 'empty', 'Choisis une période plus large ou mets à jour les données.'));
      $('#tips').replaceChildren();
      $('#btnSave').disabled = true;
      return;
    }
    const s = sel();
    FIELDS.forEach((f) => $('#f-' + f.id).classList.toggle('set', !!s[f.id]));
    const has = Object.keys(s).length > 0;
    const res = M.predict(m, s);
    const ex = exactMatch(s);
    const score = has ? res.score : null;
    const tier = score == null ? 'none' : M.tierOf(score);
    app.dataset.tier = tier;

    const sc = $('#score');
    sc.textContent = score == null ? '––' : String(score);
    sc.setAttribute('aria-valuenow', score == null ? '' : String(score));
    sc.setAttribute('aria-label', score == null ? 'Pas encore de score' : 'Score du setup : ' + score + ' sur 100');
    $('#tier').textContent = score == null ? 'EN ATTENTE' : M.TIER_LABEL[tier];
    $('#tierSub').textContent = TIER_SUB[tier];
    $('#gauge').dataset.tier = tier;
    const p = score == null ? 0 : score / 100;
    $('#gaugeFill').style.setProperty('--p', String(p));
    const mk = $('#gaugeMark');
    mk.style.setProperty('--p', String(p));
    mk.style.display = score == null ? 'none' : 'block';

    const conf = confidence(res.parts, ex);
    const kv = $('#kv');
    kv.replaceChildren();
    const item = (label, value, cls) => { const d = ce('div'); d.appendChild(ce('dt', '', label)); d.appendChild(ce('dd', cls || '', value)); kv.appendChild(d); return d; };
    item('R attendu / trade', has ? fR(res.E) : '—', has ? (res.E > 0 ? 'pos' : 'neg') : '');
    item('Win rate estimé', has ? fP(res.W) : '—');
    const cf = item('Confiance', '', 'conf');
    const dd = $('dd', cf);
    const pips = ce('span', 'pips');
    for (let i = 1; i <= 3; i++) pips.appendChild(ce('i', i <= conf.level ? 'on' : ''));
    dd.append(pips);
    cf.title = conf.text;
    const ident = $('#ident');
    ident.replaceChildren();
    if (has) {
      if (ex.n) {
        ident.append(ce('b', '', ex.n + ' trades identiques'), ' · ' + ex.wins + ' gagnants · ' + fR(ex.avg));
        if (ex.pris.n || ex.manques.n) ident.append(ce('span', 'muted', '  (' + ex.pris.n + ' pris' + (ex.pris.n ? ' ' + fR(ex.pris.avg) : '') + ' · ' + ex.manques.n + ' manqués' + (ex.manques.n ? ' ' + fR(ex.manques.avg) : '') + ')'));
      } else ident.append('Aucun trade identique dans ton historique.');
    }
    const hint = $('#hint');
    hint.textContent = has && (ex.n || conf.level < 2) ? conf.text + '.' : '';
    if (has && ex.n >= 5 && Math.abs(ex.avg - res.E) > 0.6) {
      hint.textContent = 'Les ' + ex.n + ' trades identiques ont rapporté ' + fR(ex.avg) + ', le modèle attend ' + fR(res.E) + ' : trop peu de trades pour confirmer, d’où un score prudent.';
    }

    // champs déduits
    const full = M.withAuto(s);
    const au = $('#autos');
    au.replaceChildren();
    M.AUTO.forEach((a) => {
      if (!full[a.id]) return;
      const c = ce('span', 'chip');
      c.append(ce('em', '', 'auto · ' + a.label), M.showVal(a.id, full[a.id]));
      au.appendChild(c);
    });

    // impact de chaque champ
    const mods = $('#mods');
    mods.replaceChildren();
    $('#impactBadge').textContent = res.parts.length ? res.parts.filter((p) => !p.auto).length + ' champ(s)' : '';
    if (!res.parts.length) mods.appendChild(ce('p', 'empty', 'Aucun champ pour l’instant. Chaque champ choisi montrera ici combien de R il ajoute ou retire.'));
    const maxAbs = Math.max(0.3, ...res.parts.map((x) => Math.abs(x.r)));
    [...res.parts].sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).forEach((x) => {
      const row = ce('div', 'mod');
      const lab = ce('span', 'mod-l');
      lab.append(ce('em', '', (x.auto ? 'auto · ' : '') + M.labelOf(x.dim)), M.showVal(x.dim, x.value));
      row.appendChild(lab);
      const bar = ce('span', 'bar2');
      const i = ce('i', x.r >= 0 ? 'up' : 'down');
      i.style.width = Math.max(2, (Math.abs(x.r) / maxAbs) * 50) + '%';
      bar.appendChild(i);
      row.appendChild(bar);
      row.appendChild(ce('span', 'mod-v ' + (x.unseen ? '' : x.r >= 0 ? 'pos' : 'neg'), x.unseen ? 'aucune donnée' : fR(x.r)));
      mods.appendChild(row);
    });

    // pistes
    const tips = $('#tips');
    tips.replaceChildren();
    const cand = [];
    FIELDS.forEach((f) => {
      if (s[f.id]) return;
      const blk = m.blocks[f.id];
      if (!blk) return;
      blk.cols.forEach((c) => {
        if (c.n < 5) return;
        const r2 = M.predict(m, { ...s, [f.id]: c.value });
        cand.push({ dim: f.id, value: c.value, n: c.n, delta: r2.score - (has ? res.score : 50) });
      });
    });
    const ups = cand.filter((c) => c.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3);
    const downs = cand.filter((c) => c.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3);
    const box = (title, cls, list) => {
      const b = ce('div', 'tipbox ' + cls);
      b.appendChild(ce('div', 'tip-h', title));
      if (!list.length) b.appendChild(ce('p', 'empty', '—'));
      list.forEach((c) => {
        const t = ce('button', 'tip');
        t.type = 'button';
        t.title = 'Appliquer ce champ';
        t.append(ce('span', '', M.labelOf(c.dim) + ' : ' + M.showVal(c.dim, c.value)), ce('b', '', (c.delta > 0 ? '+' : '') + c.delta));
        t.addEventListener('click', () => { $('#f-' + c.dim).value = c.value; refresh(); });
        b.appendChild(t);
      });
      tips.appendChild(b);
    };
    box(has ? 'Améliore le score' : 'Meilleurs départs', 'good', ups);
    box(has ? 'Dégrade le score' : 'Pires départs', 'bad', downs);

    $('#btnSave').disabled = !has;
    renderWatch();
  }

  // ---- setups suivis ------------------------------------------------------------------------------------------------------
  const nameFor = (fields) => FIELDS.filter((f) => fields[f.id]).map((f) => M.showVal(f.id, fields[f.id])).slice(0, 4).join(' · ') || 'Setup';
  function renderWatch() {
    const host = $('#watch');
    host.replaceChildren();
    $('#watchBadge').textContent = st.setups.length ? String(st.setups.length) : '';
    if (!st.setups.length) { host.appendChild(ce('p', 'empty', 'Aucun setup suivi. Remplis le formulaire puis « Enregistrer ».')); return; }
    if (!st.model) { host.appendChild(ce('p', 'empty', 'Scores indisponibles : pas assez de données sur la période.')); return; }
    const scored = st.setups.map((x) => ({ ...x, res: M.predict(st.model, x.fields) })).sort((a, b) => b.res.score - a.res.score);
    scored.forEach((x) => {
      const t = M.tierOf(x.res.score);
      const row = ce('div', 'wrow' + (st.watchOpen.has(x.id) ? ' open' : ''));
      const head = ce('button', 'whead');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(st.watchOpen.has(x.id)));
      head.append(ce('span', 'pill ' + t, String(x.res.score)), ce('span', 'wname', x.name), ce('span', 'wtier ' + t, M.TIER_LABEL[t]));
      const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chev.setAttribute('viewBox', '0 0 24 24'); chev.setAttribute('width', '14'); chev.setAttribute('height', '14'); chev.setAttribute('class', 'chev');
      chev.innerHTML = '<path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
      head.appendChild(chev);
      head.addEventListener('click', () => {
        if (st.watchOpen.has(x.id)) st.watchOpen.delete(x.id); else st.watchOpen.add(x.id);
        const open = st.watchOpen.has(x.id);
        row.classList.toggle('open', open);
        head.setAttribute('aria-expanded', String(open));
      });
      row.appendChild(head);
      const det = ce('div', 'wdetail');
      const g = ce('div', 'wgauge');
      const gi = ce('i');
      gi.style.width = x.res.score + '%';
      gi.style.background = 'var(--' + t + ')';
      g.appendChild(gi);
      det.appendChild(g);
      const tags = ce('div', 'tags');
      FIELDS.filter((f) => x.fields[f.id]).forEach((f) => tags.appendChild(ce('span', 'tag', M.showVal(f.id, x.fields[f.id]))));
      det.appendChild(tags);
      det.appendChild(ce('div', 'wsub', 'R attendu ' + fR(x.res.E) + ' · win rate ' + fP(x.res.W)));
      const act = ce('div', 'wact');
      const load = ce('button', 'btn', 'Charger');
      load.type = 'button';
      load.addEventListener('click', () => loadSetup(x));
      const del = ce('button', 'btn danger', 'Supprimer');
      del.type = 'button';
      del.addEventListener('click', () => {
        st.setups = st.setups.filter((y) => y.id !== x.id);
        st.watchOpen.delete(x.id);
        api.save({ setups: st.setups });
        renderWatch();
      });
      act.append(load, del);
      det.appendChild(act);
      row.appendChild(det);
      host.appendChild(row);
    });
  }
  function loadSetup(x) {
    FIELDS.forEach((f) => { $('#f-' + f.id).value = ''; });
    fillOptions(x.fields);
    $('#name').value = x.name;
    refresh();
    $('#main').scrollTo({ top: 0, behavior: 'smooth' });
  }
  function saveSetup() {
    const s = sel();
    if (!Object.keys(s).length) return;
    const nm = $('#name').value.trim() || nameFor(s);
    const id = 's' + Date.now().toString(36);
    st.setups = [{ id, name: nm, fields: s, created: new Date().toISOString() }, ...st.setups].slice(0, 80);
    api.save({ setups: st.setups });
    $('#name').value = '';
    renderWatch();
    openFold('watch', true);
  }
  function clearAll() {
    FIELDS.forEach((f) => { $('#f-' + f.id).value = ''; });
    $('#name').value = '';
    refresh();
  }

  // ---- fiabilité et données ------------------------------------------------------------------------------------------------
  function renderData() {
    const m = st.model;
    const rel = $('#rel');
    rel.replaceChildren();
    const badge = $('#relBadge');
    if (m) {
      const cr = m.rel.corr;
      const lvl = cr >= 0.2 ? 'good' : cr >= 0.1 ? 'mid' : 'low';
      rel.dataset.level = lvl;
      rel.appendChild(ce('b', '', 'Fiabilité du modèle : ' + (lvl === 'good' ? 'BONNE' : lvl === 'mid' ? 'MOYENNE' : 'FAIBLE')));
      rel.appendChild(ce('span', '', lvl === 'good'
        ? 'Sur des setups qu’il n’a pas vus, le modèle retrouve une vraie partie de l’écart entre setups.'
        : lvl === 'mid'
          ? 'Le modèle capte une partie des écarts sur des setups non vus : un repère utile, pas une certitude.'
          : 'Sur des setups non vus, le modèle ne retrouve presque pas les écarts : les différences entre setups restent proches du bruit. Prends le score comme un repère, pas comme un feu vert.'));
      rel.appendChild(ce('em', '', 'Corrélation en validation croisée : ' + tf(cr, 2) + (st.mode === 'prudent' ? ' · effets ramenés à ' + Math.round(m.shrink * 100) + ' % de leur valeur historique' : ' · lecture brute')));
      badge.textContent = lvl === 'good' ? 'bonne' : lvl === 'mid' ? 'moyenne' : 'faible';
      badge.className = 'badge ' + (lvl === 'good' ? 'good' : lvl === 'mid' ? 'warn' : 'bad');
    } else {
      rel.dataset.level = 'low';
      rel.appendChild(ce('b', '', 'Données insuffisantes'));
      rel.appendChild(ce('span', '', 'Il faut au moins 20 setups sur la période choisie.'));
      badge.textContent = '';
    }
    const meta = st.meta || {};
    const pris = st.all.filter((t) => t.statut === 'Pris').length, man = st.all.filter((t) => t.statut === 'Manqué').length;
    const when = meta.importedAt ? ' · importé le ' + new Date(meta.importedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    $('#dataline').textContent = (meta.name || 'Données') + when + ' · ' + st.all.length + ' setups (' + pris + ' pris, ' + man + ' manqués) · ' + st.trades.length + ' sur la période';
    $('#btnReset').hidden = meta.source !== 'import';
    $('#mode').value = st.mode;
    $('#period').value = st.period;
    $('#app').title = 'Raccourci : ' + st.shortcut;
  }

  async function doImport() {
    const msg = st.all.length ? $('#importMsg') : $('#onboardMsg');
    msg.className = 'note';
    msg.textContent = 'Choisis le fichier exporté de Notion…';
    const r = await api.importData();
    if (r.canceled) { msg.textContent = ''; return; }
    if (r.error) { msg.className = 'note err'; msg.textContent = r.error; return; }
    applyData(r.trades, r.meta);
    const s = r.meta.summary || {};
    msg.textContent = 'Importé : ' + s.total + ' setups (' + s.pris + ' pris, ' + s.manques + ' manqués). ' + s.doublons + ' copie(s) backtest d’un trade réel retirée(s)' + (s.ignores ? ', ' + s.ignores + ' ligne(s) illisible(s) ignorée(s)' : '') + '.';
  }
  async function doReset() {
    const r = await api.resetData();
    applyData(r.trades, r.meta);
    $('#importMsg').textContent = 'Retour aux données intégrées.';
  }
  function applyData(trades, meta) {
    st.all = trades;
    st.meta = meta;
    $('#onboard').hidden = trades.length > 0;
    refit();
    fillOptions();
    renderData();
    refresh();
  }

  // ---- sections dépliables --------------------------------------------------------------------------------------------------
  function openFold(id, open) {
    const f = $('#fold-' + id);
    f.classList.toggle('open', open);
    $('.fold-head', f).setAttribute('aria-expanded', String(open));
    st.open[id] = open;
    api.save({ open: { [id]: open } });
  }
  function bindFolds() {
    ['impact', 'watch', 'data'].forEach((id) => {
      const f = $('#fold-' + id);
      const open = !!st.open[id];
      f.classList.toggle('open', open);
      $('.fold-head', f).setAttribute('aria-expanded', String(open));
      $('.fold-head', f).addEventListener('click', () => openFold(id, !f.classList.contains('open')));
    });
  }

  // ---- démarrage ---------------------------------------------------------------------------------------------------------------
  async function boot() {
    if (window.ShaderBg) try { window.ShaderBg.start($('#bg')); } catch (e) { /* fond uni en repli */ }
    const init = await api.load();
    const s = init.settings || {};
    st.mode = s.mode === 'brut' ? 'brut' : 'prudent';
    st.period = s.period || 'all';
    st.open = s.open || {};
    st.setups = Array.isArray(s.setups) ? s.setups : [];
    st.pinned = s.pinned !== false;
    st.shortcut = init.shortcut || st.shortcut;
    buildFields();
    bindFolds();
    $('#btnPin').setAttribute('aria-pressed', String(st.pinned));
    $('#btnPin').addEventListener('click', async () => {
      st.pinned = await api.pin(!st.pinned);
      $('#btnPin').setAttribute('aria-pressed', String(st.pinned));
    });
    $('#btnMin').addEventListener('click', () => api.minimize());
    $('#btnClose').addEventListener('click', () => api.hide());
    $('#btnSave').addEventListener('click', saveSetup);
    $('#btnClear').addEventListener('click', clearAll);
    $('#btnImport').addEventListener('click', doImport);
    $('#btnReset').addEventListener('click', doReset);
    $('#btnOnboard').addEventListener('click', doImport);
    $('#btnUpdate').addEventListener('click', () => api.installUpdate && api.installUpdate());
    if (api.onUpdate) {
      api.onUpdate((u) => {
        $('#update').hidden = false;
        $('#updateText').textContent = u.state === 'ready' ? 'Mise à jour ' + u.version + ' prête à installer.' : 'Mise à jour ' + u.version + ' en cours de téléchargement…';
        $('#btnUpdate').hidden = u.state !== 'ready';
      });
    }
    $('#mode').addEventListener('change', (e) => { st.mode = e.target.value; applyMode(); api.save({ mode: st.mode }); renderData(); refresh(); });
    $('#period').addEventListener('change', (e) => { st.period = e.target.value; api.save({ period: st.period }); refit(); fillOptions(); renderData(); refresh(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.target.matches('select, input')) api.hide(); });
    applyData(init.trades, init.meta);
  }
  boot();
})();
