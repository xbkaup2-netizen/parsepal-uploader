import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } from 'electron';
import * as path from 'path';
import * as https from 'https';
import * as fs from 'fs';
import { store } from './store';
import { FileWatcher } from './fileWatcher';
import { Uploader } from './uploader';
import type { AuthResponse, WatcherStatus } from '../shared/types';

const API_BASE = 'https://parsepal-production.up.railway.app';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let fileWatcher: FileWatcher | null = null;
let uploader: Uploader | null = null;

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
    const entry = uploader!.uploadFight(fight);
    mainWindow?.webContents.send('fight:detected', entry);
  });
  fileWatcher.onStatus = (status: WatcherStatus) => {
    mainWindow?.webContents.send('watcher:status-change', status);
  };

  await fileWatcher.start();
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
    store.setSettings(partial);
    if (partial.launchOnStartup !== undefined) {
      app.setLoginItemSettings({ openAtLogin: partial.launchOnStartup });
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

  ipcMain.handle('watcher:stop', async () => {
    if (fileWatcher) {
      await fileWatcher.stop();
      fileWatcher = null;
    }
  });

  ipcMain.handle('watcher:status', () => {
    return fileWatcher?.getStatus() || 'idle';
  });

  ipcMain.handle('history:get', () => {
    return store.getHistory();
  });

  ipcMain.handle('history:clear', () => {
    store.clearHistory();
  });

  ipcMain.handle('shell:open-external', (_event, url: string) => {
    return shell.openExternal(url);
  });
}

// ── App lifecycle ───────────────────────────────────────────────────
app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  createTray();

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

app.on('before-quit', async () => {
  if (fileWatcher) {
    await fileWatcher.stop();
  }
});
