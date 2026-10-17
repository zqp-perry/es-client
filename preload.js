'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('cfg:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('cfg:save', cfg),
  request: (payload) => ipcRenderer.invoke('es:req', payload),
  info: () => ipcRenderer.invoke('app:info')
});
