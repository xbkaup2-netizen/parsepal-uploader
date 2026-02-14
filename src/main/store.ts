import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
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
        return {
          settings: { ...DEFAULTS, ...parsed.settings },
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
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
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
