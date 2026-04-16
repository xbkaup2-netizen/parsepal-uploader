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

  getWatchedFile: () =>
    ipcRenderer.invoke('watcher:watched-file'),

  scanExisting: () =>
    ipcRenderer.invoke('watcher:scan-existing'),

  scanAllLogs: () =>
    ipcRenderer.invoke('watcher:scan-all'),

  scanAllPreview: () =>
    ipcRenderer.invoke('watcher:scan-all-preview'),

  uploadSelected: (fightIds: string[]) =>
    ipcRenderer.invoke('watcher:upload-selected', fightIds),

  getLogFileCount: () =>
    ipcRenderer.invoke('watcher:log-count'),

  onScanProgress: (callback) => {
    ipcRenderer.on('watcher:scan-progress', (_event, progress) => callback(progress));
  },

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

  onWatchedFileChange: (callback) => {
    ipcRenderer.on('watcher:file-change', (_event, filename) => callback(filename));
  },

  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('fight:detected');
    ipcRenderer.removeAllListeners('upload:progress');
    ipcRenderer.removeAllListeners('watcher:status-change');
    ipcRenderer.removeAllListeners('watcher:file-change');
    ipcRenderer.removeAllListeners('updater:status');
    ipcRenderer.removeAllListeners('watcher:scan-progress');
  },

  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:open-external', url),

  // Addon management
  getAddonPath: () =>
    ipcRenderer.invoke('addon:get-path'),

  installAddon: () =>
    ipcRenderer.invoke('addon:install'),

  // Auto-update
  checkForUpdate: () =>
    ipcRenderer.invoke('updater:check'),

  installUpdate: () =>
    ipcRenderer.invoke('updater:install'),

  getAppVersion: () =>
    ipcRenderer.invoke('app:version'),

  onUpdaterStatus: (callback) => {
    ipcRenderer.on('updater:status', (_event, status) => callback(status));
  },
};

contextBridge.exposeInMainWorld('api', api);
