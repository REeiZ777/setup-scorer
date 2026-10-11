'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('state:load'),
  save: (patch) => ipcRenderer.invoke('state:save', patch),
  pin: (on) => ipcRenderer.invoke('win:pin', on),
  minimize: () => ipcRenderer.send('win:minimize'),
  hide: () => ipcRenderer.send('win:hide'),
  importData: () => ipcRenderer.invoke('data:import'),
  resetData: () => ipcRenderer.invoke('data:reset'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, s) => cb(s)),
  installUpdate: () => ipcRenderer.send('update:install'),
});
