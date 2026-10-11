'use strict';
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, nativeImage, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { importFile } = require('./src/importer');
const { autoUpdater } = require('electron-updater');

const SHORTCUT = 'CommandOrControl+Alt+S';
const ICON = path.join(__dirname, 'build', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'build', 'tray.png');

let win = null;
let tray = null;
let quitting = false;

// ---- fichiers de l'utilisateur ----------------------------------------------------------------
const userFile = (name) => path.join(app.getPath('userData'), name);
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data));
    fs.renameSync(file + '.tmp', file);
    return true;
  } catch (e) { return false; }
}
// Les données personnelles ne sont pas livrées avec l'application : au premier lancement, l'utilisateur importe son journal.
// En développement, un data/trades.json local (ignoré par git) est utilisé s'il existe.
const bundledTrades = () => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'trades.json'), 'utf8')); } catch (e) { return []; }
};

let settings = { pinned: true, bounds: null, mode: 'prudent', period: 'all', open: { impact: false, watch: false, data: false }, setups: [] };
function loadSettings() { settings = { ...settings, ...readJson(userFile('settings.json'), {}) }; }
let saveTimer = null;
function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(userFile('settings.json'), settings), 250);
}

// ---- fenêtre ---------------------------------------------------------------------------------------
function visibleBounds(b) {
  if (!b) return null;
  const ok = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + 40 < a.x + a.width && b.x + b.width - 40 > a.x && b.y + 20 < a.y + a.height && b.y + 40 > a.y;
  });
  return ok ? b : null;
}

function createWindow() {
  const saved = visibleBounds(settings.bounds);
  win = new BrowserWindow({
    width: saved ? saved.width : 430,
    height: saved ? saved.height : 780,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    minWidth: 360,
    minHeight: 300,
    frame: false,
    backgroundColor: '#0b0c0f',
    show: false,
    title: 'Setup Scorer',
    icon: ICON,
    alwaysOnTop: settings.pinned,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (settings.pinned) win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  const remember = () => {
    if (!win || win.isMinimized() || win.isMaximized()) return;
    settings.bounds = win.getBounds();
    saveSettingsSoon();
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); }
}

function createTray() {
  let img = nativeImage.createFromPath(TRAY_ICON);
  if (img.isEmpty()) img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Setup Scorer · ' + SHORTCUT.replace('CommandOrControl', 'Ctrl'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher / masquer', click: toggleWindow },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', toggleWindow);
}

// ---- IPC ----------------------------------------------------------------------------------------------
function currentData() {
  const stored = readJson(userFile('trades.json'), null);
  if (stored && Array.isArray(stored.trades) && stored.trades.length) return stored;
  const dev = bundledTrades();
  if (dev.length) return { trades: dev, meta: { source: 'bundled', name: 'Données locales de développement', importedAt: null, summary: null } };
  return { trades: [], meta: { source: 'none', name: 'Aucune donnée', importedAt: null, summary: null } };
}

ipcMain.handle('state:load', () => {
  const d = currentData();
  return { settings, trades: d.trades, meta: d.meta, shortcut: SHORTCUT.replace('CommandOrControl', 'Ctrl'), version: app.getVersion() };
});
ipcMain.handle('state:save', (_e, patch) => {
  if (patch && typeof patch === 'object') {
    ['mode', 'period'].forEach((k) => { if (typeof patch[k] === 'string') settings[k] = patch[k]; });
    if (patch.open && typeof patch.open === 'object') settings.open = { ...settings.open, ...patch.open };
    if (Array.isArray(patch.setups)) settings.setups = patch.setups.slice(0, 80);
    saveSettingsSoon();
  }
  return true;
});
ipcMain.handle('win:pin', (_e, on) => {
  settings.pinned = !!on;
  if (win) win.setAlwaysOnTop(settings.pinned, settings.pinned ? 'screen-saver' : 'normal');
  saveSettingsSoon();
  return settings.pinned;
});
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:hide', () => win && win.hide());
ipcMain.handle('data:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choisir l’export Notion du journal',
    properties: ['openFile'],
    filters: [{ name: 'Export du journal (zip ou csv)', extensions: ['zip', 'csv'] }],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  try {
    const file = res.filePaths[0];
    const out = importFile(fs.readFileSync(file), path.basename(file));
    if (out.trades.length < 20) return { error: 'Seulement ' + out.trades.length + ' setups lisibles dans ce fichier : il en faut au moins 20.' };
    const meta = { source: 'import', name: path.basename(file), importedAt: new Date().toISOString(), summary: out.summary };
    writeJson(userFile('trades.json'), { trades: out.trades, meta });
    return { ok: true, trades: out.trades, meta };
  } catch (e) {
    return { error: e && e.message ? e.message : 'Import impossible.' };
  }
});
ipcMain.handle('data:reset', () => {
  try { fs.unlinkSync(userFile('trades.json')); } catch (e) { /* déjà absent */ }
  const d = currentData();
  return { trades: d.trades, meta: d.meta };
});

// ---- mises à jour automatiques -------------------------------------------------------------------------
// Les versions publiées sur GitHub Releases sont vérifiées au lancement puis toutes les 6 heures ;
// la mise à jour est téléchargée en arrière-plan et installée au prochain redémarrage (ou tout de suite sur demande).
function sendUpdate(state, extra) {
  if (win && !win.isDestroyed()) win.webContents.send('update', { state, ...extra });
}
function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => sendUpdate('downloading', { version: info.version }));
  autoUpdater.on('update-downloaded', (info) => sendUpdate('ready', { version: info.version }));
  autoUpdater.on('error', () => { /* hors ligne ou dépôt injoignable : on réessaiera plus tard */ });
  const check = () => { autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 8000);
  setInterval(check, 6 * 60 * 60 * 1000);
}
ipcMain.on('update:install', () => { quitting = true; autoUpdater.quitAndInstall(); });

// ---- cycle de vie ----------------------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    loadSettings();
    createWindow();
    createTray();
    globalShortcut.register(SHORTCUT, toggleWindow);
    setupUpdates();
    app.on('activate', () => { if (win) win.show(); });
  });
  app.on('before-quit', () => { quitting = true; if (win) { settings.bounds = settings.bounds || win.getBounds(); } writeJson(userFile('settings.json'), settings); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { /* reste dans la zone de notification */ });
}
