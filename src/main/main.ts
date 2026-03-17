import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } from 'electron';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { autoUpdater } from 'electron-updater';
import { store } from './store';
import { FileWatcher, ScanProgress } from './fileWatcher';
import { Uploader } from './uploader';
import type { AuthResponse, WatcherStatus, ScannedFight, ScannedFileGroup } from '../shared/types';

const API_BASE = 'https://parsepal-production.up.railway.app';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let fileWatcher: FileWatcher | null = null;
let uploader: Uploader | null = null;

// Cache of scanned fights from the last preview scan, keyed by fight ID
let scannedFightsCache: Map<string, ScannedFight> = new Map();

// ── Single instance lock ────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Helper: HTTPS request ───────────────────────────────────────────
function makeHttpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ statusCode: res.statusCode || 500, data: JSON.parse(raw) });
        } catch {
          resolve({ statusCode: res.statusCode || 500, data: raw });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Window creation ─────────────────────────────────────────────────
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    resizable: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('close', (e) => {
    const settings = store.getSettings();
    if (settings.minimizeToTray && mainWindow) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── System tray ─────────────────────────────────────────────────────
function createTray(): void {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('ParsePal');

  const updateTrayMenu = () => {
    const isWatching = fileWatcher?.getStatus() === 'watching';
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Window',
        click: () => mainWindow?.show(),
      },
      { type: 'separator' },
      {
        label: isWatching ? 'Pause Watching' : 'Resume Watching',
        click: async () => {
          if (isWatching) {
            await fileWatcher?.stop();
          } else {
            const settings = store.getSettings();
            if (settings.wowPath && settings.authToken) {
              await startWatcher();
            }
          }
          updateTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          mainWindow?.destroy();
          app.quit();
        },
      },
    ]);
    tray?.setContextMenu(contextMenu);
  };

  updateTrayMenu();

  tray.on('double-click', () => {
    mainWindow?.show();
  });
}

// ── Watcher helpers ─────────────────────────────────────────────────
async function startWatcher(): Promise<void> {
  if (fileWatcher) {
    await fileWatcher.stop();
  }

  const settings = store.getSettings();
  if (!settings.wowPath || !settings.authToken) return;

  uploader = new Uploader(() => store.getSettings().authToken);
  uploader.onProgress = (entry) => {
    mainWindow?.webContents.send('upload:progress', entry);
    if (entry.status === 'done' || entry.status === 'error') {
      store.addHistory({
        id: entry.id,
        encounterName: entry.fight.encounterName,
        type: entry.fight.type,
        success: entry.fight.success,
        duration: entry.fight.duration,
        keystoneLevel: entry.fight.keystoneLevel,
        timestamp: entry.timestamp,
        analysisUrl: entry.analysisUrl,
        status: entry.status === 'done' ? 'done' : 'error',
      });
    }
  };

  fileWatcher = new FileWatcher(settings.wowPath, settings.gameVersion, (fight) => {
    if (store.getSettings().autoUpload) {
      const entry = uploader!.uploadFight(fight);
      mainWindow?.webContents.send('fight:detected', entry);
    } else {
      // Still notify the UI so the fight appears in the list, but skip upload
      mainWindow?.webContents.send('fight:detected', {
        id: crypto.randomUUID(),
        fight: {
          type: fight.type,
          encounterName: fight.encounterName,
          duration: fight.duration,
          success: fight.success,
          keystoneLevel: fight.keystoneLevel,
        },
        status: 'skipped' as const,
        progress: 0,
        timestamp: Date.now(),
      });
    }
  });
  fileWatcher.onStatus = (status: WatcherStatus) => {
    mainWindow?.webContents.send('watcher:status-change', status);
  };
  fileWatcher.onFileChange = (filename: string | null) => {
    mainWindow?.webContents.send('watcher:file-change', filename);
  };

  await fileWatcher.start();

  // Auto-scan the most recent log file so existing fights appear immediately
  if (fileWatcher.getStatus() === 'watching') {
    fileWatcher.scanExisting().catch((err) => {
      console.error('Auto-scan of latest log failed:', err);
    });
  }
}

// ── IPC handlers ────────────────────────────────────────────────────
function registerIpcHandlers(): void {
  ipcMain.handle('auth:login', async (_event, usernameOrEmail: string, password: string) => {
    try {
      const result = await makeHttpRequest(
        `${API_BASE}/api/auth/login`,
        'POST',
        { 'Content-Type': 'application/json' },
        JSON.stringify({ username: usernameOrEmail, password })
      );

      if (result.statusCode >= 200 && result.statusCode < 300) {
        const auth = result.data as AuthResponse;
        const username = auth.user?.username || usernameOrEmail;
        store.setSettings({ authToken: auth.access_token, username });
        return { ok: true, username };
      } else {
        // Never expose raw API response — could contain sensitive data
        const detail = result.data?.detail;
        const safeMsg = typeof detail === 'string' ? detail : 'Invalid username or password';
        return { ok: false, error: safeMsg };
      }
    } catch {
      return { ok: false, error: 'Unable to connect to server. Please try again.' };
    }
  });

  ipcMain.handle('auth:logout', async () => {
    store.setSettings({ authToken: '', username: '' });
    if (fileWatcher) {
      await fileWatcher.stop();
      fileWatcher = null;
    }
  });

  ipcMain.handle('auth:state', () => {
    const settings = store.getSettings();
    return { loggedIn: !!settings.authToken, username: settings.username };
  });

  ipcMain.handle('settings:get', () => {
    return store.getSettings();
  });

  ipcMain.handle('settings:set', (_event, partial) => {
    if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) return;

    // Whitelist allowed keys and validate types
    const allowed: Partial<Record<string, string>> = {
      wowPath: 'string', gameVersion: 'string', autoUpload: 'boolean',
      minimizeToTray: 'boolean', launchOnStartup: 'boolean',
    };
    const validated: Record<string, unknown> = {};
    for (const [key, expectedType] of Object.entries(allowed)) {
      if (key in partial && typeof partial[key] === expectedType) {
        validated[key] = partial[key];
      }
    }
    // Validate wowPath doesn't contain traversal
    if (typeof validated.wowPath === 'string' && validated.wowPath.includes('..')) {
      delete validated.wowPath;
    }

    store.setSettings(validated);
    if (validated.launchOnStartup !== undefined) {
      app.setLoginItemSettings({ openAtLogin: validated.launchOnStartup as boolean });
    }
  });

  ipcMain.handle('dialog:browse-wow', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select World of Warcraft installation folder',
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const selected = result.filePaths[0];
    const hasRetail = fs.existsSync(path.join(selected, '_retail_', 'Logs'));
    const hasClassic = fs.existsSync(path.join(selected, '_classic_', 'Logs'));
    const hasClassicEra = fs.existsSync(path.join(selected, '_classic_era_', 'Logs'));

    if (hasRetail || hasClassic || hasClassicEra) {
      return selected;
    }
    return null;
  });

  ipcMain.handle('dialog:detect-wow', () => {
    const candidates = [
      'C:/Program Files (x86)/World of Warcraft',
      'C:/Program Files/World of Warcraft',
      'D:/World of Warcraft',
      'D:/Games/World of Warcraft',
      '/Applications/World of Warcraft',
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const hasRetail = fs.existsSync(path.join(candidate, '_retail_', 'Logs'));
        const hasClassic = fs.existsSync(path.join(candidate, '_classic_', 'Logs'));
        if (hasRetail || hasClassic) {
          return candidate;
        }
      }
    }
    return null;
  });

  ipcMain.handle('watcher:start', async () => {
    await startWatcher();
  });

  ipcMain.handle('watcher:scan-existing', async () => {
    if (!fileWatcher) return 0;
    return fileWatcher.scanExisting();
  });

  ipcMain.handle('watcher:scan-all', async () => {
    const settings = store.getSettings();

    // If we have a live fileWatcher, use it (it knows the logsDir and onFight callback)
    if (fileWatcher) {
      return fileWatcher.scanAllLogs((progress: ScanProgress) => {
        mainWindow?.webContents.send('watcher:scan-progress', progress);
      });
    }

    // No watcher running — create a temporary one just for scanning
    if (!settings.wowPath) return 0;

    const tempOnFight = (fight: import('../shared/types').Fight) => {
      if (settings.authToken && uploader) {
        if (store.getSettings().autoUpload) {
          const entry = uploader.uploadFight(fight);
          mainWindow?.webContents.send('fight:detected', entry);
        } else {
          mainWindow?.webContents.send('fight:detected', {
            id: crypto.randomUUID(),
            fight: {
              type: fight.type,
              encounterName: fight.encounterName,
              duration: fight.duration,
              success: fight.success,
              keystoneLevel: fight.keystoneLevel,
            },
            status: 'skipped' as const,
            progress: 0,
            timestamp: Date.now(),
          });
        }
      } else {
        mainWindow?.webContents.send('fight:detected', {
          id: crypto.randomUUID(),
          fight: {
            type: fight.type,
            encounterName: fight.encounterName,
            duration: fight.duration,
            success: fight.success,
            keystoneLevel: fight.keystoneLevel,
          },
          status: 'skipped' as const,
          progress: 0,
          timestamp: Date.now(),
        });
      }
    };

    const tempWatcher = new FileWatcher(settings.wowPath, settings.gameVersion, tempOnFight);
    const count = await tempWatcher.scanAllLogs((progress: ScanProgress) => {
      mainWindow?.webContents.send('watcher:scan-progress', progress);
    });
    return count;
  });

  ipcMain.handle('watcher:scan-all-preview', async () => {
    const settings = store.getSettings();
    let watcher: FileWatcher;

    if (fileWatcher) {
      watcher = fileWatcher;
    } else if (settings.wowPath) {
      watcher = new FileWatcher(settings.wowPath, settings.gameVersion, () => {});
    } else {
      return [];
    }

    const groups: ScannedFileGroup[] = await watcher.scanAllLogsPreview(
      (progress: ScanProgress) => {
        mainWindow?.webContents.send('watcher:scan-progress', progress);
      },
    );

    // Cache all fights by ID so we can look them up for upload
    scannedFightsCache.clear();
    for (const group of groups) {
      for (const fight of group.fights) {
        scannedFightsCache.set(fight.id, fight);
      }
    }

    // Strip the raw lines from the response to avoid sending huge data over IPC
    // The main process keeps them in the cache
    const stripped: ScannedFileGroup[] = groups.map((g) => ({
      ...g,
      fights: g.fights.map((f) => ({ ...f, lines: [] })),
    }));

    return stripped;
  });

  ipcMain.handle('watcher:upload-selected', async (_event, fightIds: string[]) => {
    if (!Array.isArray(fightIds) || fightIds.length === 0) return 0;

    const settings = store.getSettings();
    if (!settings.authToken) return 0;

    // Ensure uploader exists
    if (!uploader) {
      uploader = new Uploader(() => store.getSettings().authToken);
      uploader.onProgress = (entry) => {
        mainWindow?.webContents.send('upload:progress', entry);
        if (entry.status === 'done' || entry.status === 'error') {
          store.addHistory({
            id: entry.id,
            encounterName: entry.fight.encounterName,
            type: entry.fight.type,
            success: entry.fight.success,
            duration: entry.fight.duration,
            keystoneLevel: entry.fight.keystoneLevel,
            timestamp: entry.timestamp,
            analysisUrl: entry.analysisUrl,
            status: entry.status === 'done' ? 'done' : 'error',
          });
        }
      };
    }

    let uploadCount = 0;
    for (const id of fightIds) {
      const sf = scannedFightsCache.get(id);
      if (!sf) continue;

      const fight = {
        type: sf.type as 'raid' | 'mythicplus',
        encounterName: sf.encounterName,
        encounterID: 0,
        startTime: sf.startTime,
        endTime: '',
        duration: sf.duration,
        success: sf.success,
        keystoneLevel: sf.keystoneLevel,
        lines: sf.lines,
        playerCount: sf.playerCount,
        fileSize: sf.fileSize,
      };

      const entry = uploader.uploadFight(fight);
      mainWindow?.webContents.send('fight:detected', entry);
      uploadCount++;

      // Remove from cache after queuing upload
      scannedFightsCache.delete(id);
    }

    return uploadCount;
  });

  ipcMain.handle('watcher:log-count', () => {
    if (fileWatcher) {
      return fileWatcher.listAllLogs().length;
    }
    const settings = store.getSettings();
    if (!settings.wowPath) return 0;
    const tempWatcher = new FileWatcher(settings.wowPath, settings.gameVersion, () => {});
    return tempWatcher.listAllLogs().length;
  });

  ipcMain.handle('watcher:stop', async () => {
    if (fileWatcher) {
      await fileWatcher.stop();
      fileWatcher = null;
    }
  });

  ipcMain.handle('watcher:status', () => {
    return fileWatcher?.getStatus() || 'idle';
  });

  ipcMain.handle('watcher:watched-file', () => {
    return fileWatcher?.getWatchedFile() || null;
  });

  ipcMain.handle('history:get', () => {
    return store.getHistory();
  });

  ipcMain.handle('history:clear', () => {
    store.clearHistory();
  });

  ipcMain.handle('shell:open-external', (_event, url: string) => {
    const ALLOWED_HOSTS = [
      'parsepal.gg',
      'www.parsepal.gg',
      'battle.net',
      'us.battle.net',
      'eu.battle.net',
      'github.com',
      'discord.gg',
      'discord.com',
    ];

    try {
      const parsed = new URL(url);

      if (parsed.protocol !== 'https:') {
        console.warn(`[shell:open-external] Blocked non-https URL: ${url}`);
        return;
      }

      const hostname = parsed.hostname.toLowerCase();
      const allowed = ALLOWED_HOSTS.some(
        (host) => hostname === host || hostname.endsWith(`.${host}`)
      );

      if (!allowed) {
        console.warn(`[shell:open-external] Blocked disallowed host: ${hostname}`);
        return;
      }

      return shell.openExternal(url);
    } catch {
      console.warn(`[shell:open-external] Blocked malformed URL: ${url}`);
    }
  });

  // ── Auto-update IPC ───────────────────────────────────────────────
  ipcMain.handle('updater:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { available: !!result?.updateInfo, version: result?.updateInfo?.version };
    } catch {
      return { available: false };
    }
  });

  ipcMain.handle('updater:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });
}

// ── Auto-updater ────────────────────────────────────────────────────
function setupAutoUpdater(): void {
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
  } catch {
    console.warn('Auto-updater init failed — skipping');
    return;
  }

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('updater:status', {
      status: 'available',
      version: info.version,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('updater:status', {
      status: 'downloading',
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('updater:status', {
      status: 'ready',
      version: info.version,
    });
  });

  autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('updater:status', {
      status: 'error',
      error: err.message,
    });
  });

  // Check for updates every 30 minutes
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 30 * 60 * 1000);
}

// ── App lifecycle ───────────────────────────────────────────────────
app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  createTray();

  if (app.isPackaged) {
    try {
      setupAutoUpdater();
    } catch {
      console.warn('Auto-updater setup failed — app will run without auto-updates');
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let isQuitting = false;
app.on('before-quit', (e) => {
  if (isQuitting) return;
  isQuitting = true;
  e.preventDefault();
  const cleanup = fileWatcher ? fileWatcher.stop() : Promise.resolve();
  cleanup.finally(() => app.exit(0));
});
