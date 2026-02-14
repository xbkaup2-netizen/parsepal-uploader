/** Detected fight from the combat log */
export interface Fight {
  type: 'raid' | 'mythicplus';
  encounterName: string;
  encounterID: number;
  startTime: string;
  endTime: string;
  duration: number;
  success: boolean;
  keystoneLevel?: number;
  lines: string[];
  playerCount: number;
  fileSize: number;
}

/** Upload status for a single fight */
export interface UploadEntry {
  id: string;
  fight: Pick<Fight, 'type' | 'encounterName' | 'duration' | 'success' | 'keystoneLevel'>;
  status: 'queued' | 'uploading' | 'done' | 'error';
  progress: number;
  timestamp: number;
  analysisUrl?: string;
  error?: string;
}

/** Watcher state */
export type WatcherStatus = 'idle' | 'watching' | 'paused' | 'error';

/** Persistent settings */
export interface AppSettings {
  authToken: string;
  username: string;
  wowPath: string;
  gameVersion: 'retail' | 'classic' | 'classic_era';
  autoUpload: boolean;
  minimizeToTray: boolean;
  launchOnStartup: boolean;
}

/** Upload history entry (persisted) */
export interface HistoryEntry {
  id: string;
  encounterName: string;
  type: 'raid' | 'mythicplus';
  success: boolean;
  duration: number;
  keystoneLevel?: number;
  timestamp: number;
  analysisUrl?: string;
  status: 'done' | 'error';
}

/** Auth response from the ParsePal API */
export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  user?: { username: string; email: string };
}

/** Upload response from the ParsePal API */
export interface UploadResponse {
  success: boolean;
  session_id: number;
  encounter_name: string;
  analysis_url: string;
  message: string;
}

/** API exposed to renderer via preload */
export interface ElectronAPI {
  login: (email: string, password: string) => Promise<{ ok: boolean; username?: string; error?: string }>;
  logout: () => Promise<void>;
  getAuthState: () => Promise<{ loggedIn: boolean; username: string }>;

  getSettings: () => Promise<AppSettings>;
  setSettings: (settings: Partial<AppSettings>) => Promise<void>;
  browseWowDir: () => Promise<string | null>;
  detectWowDir: () => Promise<string | null>;

  startWatcher: () => Promise<void>;
  stopWatcher: () => Promise<void>;
  getWatcherStatus: () => Promise<WatcherStatus>;

  getUploadHistory: () => Promise<HistoryEntry[]>;
  clearHistory: () => Promise<void>;

  onFightDetected: (callback: (entry: UploadEntry) => void) => void;
  onUploadProgress: (callback: (entry: UploadEntry) => void) => void;
  onWatcherStatus: (callback: (status: WatcherStatus) => void) => void;

  removeAllListeners: () => void;
  openExternal: (url: string) => Promise<void>;
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
