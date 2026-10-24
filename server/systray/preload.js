'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fpiw', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  start: () => ipcRenderer.invoke('settings:start'),
  stop: () => ipcRenderer.invoke('settings:stop'),
  openIde: () => ipcRenderer.invoke('settings:open-ide'),
  pickVfp: () => ipcRenderer.invoke('settings:pick-vfp'),
  detectVfp: () => ipcRenderer.invoke('settings:detect-vfp'),
  testVfp: (vfpPath) => ipcRenderer.invoke('settings:test-vfp', vfpPath),
  openData: () => ipcRenderer.invoke('settings:open-data'),
  openWorkspaces: () => ipcRenderer.invoke('settings:open-workspaces'),
  openLogs: () => ipcRenderer.invoke('settings:open-logs'),
  openConfig: () => ipcRenderer.invoke('settings:open-config'),
  onState: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('settings:state', (_event, state) => callback(state));
  },
  onLog: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('settings:log', (_event, line) => callback(line));
  },
});
