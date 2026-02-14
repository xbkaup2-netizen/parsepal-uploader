import * as fs from 'fs';
import * as path from 'path';
import { app, safeStorage } from 'electron';
import type { AppSettings, HistoryEntry } from '../shared/types';

const DEFAULTS: AppSettings = {
  authToken: '',
  username: '',
  wowPath: '',
  gameVersion: 'retail',
  autoUpload: true,
  minimizeToTray: true,
  launchOnStartup: false,
};

interface StoreData {
  settings: AppSettings;
  history: HistoryEntry[];
}

// Key used to store the encrypted auth token (base64 encoded)
const ENCRYPTED_TOKEN_KEY = '_authTokenEncrypted';

class Store {
  private filePath: string;
  private data: StoreData;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'parsepal-config.json');
    this.data = this.load();
  }

  private load(): StoreData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const settings = { ...DEFAULTS, ...parsed.settings };

        // Decrypt auth token if stored encrypted
        if (parsed[ENCRYPTED_TOKEN_KEY] && safeStorage.isEncryptionAvailable()) {
          try {
            const buf = Buffer.from(parsed[ENCRYPTED_TOKEN_KEY], 'base64');
            settings.authToken = safeStorage.decryptString(buf);
          } catch {
            settings.authToken = '';
          }
        }
        // Clear any plaintext token from the settings object on disk
        delete settings._authTokenEncrypted;

        return {
          settings,
          history: Array.isArray(parsed.history) ? parsed.history : [],
        };
      }
    } catch {
      // Corrupted file — start fresh
    }
    return { settings: { ...DEFAULTS }, history: [] };
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Build the object to persist — encrypt the auth token
      const settingsToSave = { ...this.data.settings };
      const output: Record<string, unknown> = {};

      if (settingsToSave.authToken && safeStorage.isEncryptionAvailable()) {
        output[ENCRYPTED_TOKEN_KEY] = safeStorage.encryptString(settingsToSave.authToken).toString('base64');
        settingsToSave.authToken = ''; // Don't store plaintext
      }

      output.settings = settingsToSave;
      output.history = this.data.history;

      fs.writeFileSync(this.filePath, JSON.stringify(output, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save store:', err);
    }
  }

  getSettings(): AppSettings {
    return { ...this.data.settings };
  }

  setSettings(partial: Partial<AppSettings>): void {
    this.data.settings = { ...this.data.settings, ...partial };
    this.save();
  }

  getHistory(): HistoryEntry[] {
    return [...this.data.history];
  }

  addHistory(entry: HistoryEntry): void {
    this.data.history.unshift(entry);
    // Keep last 50
    if (this.data.history.length > 50) {
      this.data.history = this.data.history.slice(0, 50);
    }
    this.save();
  }

  clearHistory(): void {
    this.data.history = [];
    this.save();
  }
}

export const store = new Store();
