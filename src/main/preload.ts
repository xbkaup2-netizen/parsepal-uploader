import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronAPI } from '../shared/types';

const api: ElectronAPI = {
  login: (email: string, password: string) =>
    ipcRenderer.invoke('auth:login', email, password),

  logout: () =>
    ipcRenderer.invoke('auth:logout'),

  getAuthState: () =>
    ipcRenderer.invoke('auth:state'),

  getSettings: () =>
    ipcRenderer.invoke('settings:get'),

  setSettings: (settings) =>
    ipcRenderer.invoke('settings:set', settings),

  browseWowDir: () =>
    ipcRenderer.invoke('dialog:browse-wow'),

  detectWowDir: () =>
    ipcRenderer.invoke('dialog:detect-wow'),

  startWatcher: () =>
    ipcRenderer.invoke('watcher:start'),

  stopWatcher: () =>
    ipcRenderer.invoke('watcher:stop'),

  getWatcherStatus: () =>
    ipcRenderer.invoke('watcher:status'),

  getUploadHistory: () =>
    ipcRenderer.invoke('history:get'),

  clearHistory: () =>
    ipcRenderer.invoke('history:clear'),

  onFightDetected: (callback) => {
    ipcRenderer.on('fight:detected', (_event, entry) => callback(entry));
  },

  onUploadProgress: (callback) => {
    ipcRenderer.on('upload:progress', (_event, entry) => callback(entry));
  },

  onWatcherStatus: (callback) => {
    ipcRenderer.on('watcher:status-change', (_event, status) => callback(status));
  },

  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('fight:detected');
    ipcRenderer.removeAllListeners('upload:progress');
    ipcRenderer.removeAllListeners('watcher:status-change');
  },

  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:open-external', url),
};

contextBridge.exposeInMainWorld('api', api);
