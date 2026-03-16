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
  status: 'queued' | 'uploading' | 'done' | 'error' | 'skipped';
  progress: number;
  timestamp: number;
  analysisUrl?: string;
  error?: string;
}

/** Watcher state */
// TODO: 'paused' is never emitted by the backend but is referenced in Dashboard.tsx and app.css — wire it up or remove UI references
export type WatcherStatus = 'idle' | 'watching' | 'waiting' | 'paused' | 'error';

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
  getWatchedFile: () => Promise<string | null>;
  scanExisting: () => Promise<number>;

  getUploadHistory: () => Promise<HistoryEntry[]>;
  clearHistory: () => Promise<void>;

  onFightDetected: (callback: (entry: UploadEntry) => void) => void;
  onUploadProgress: (callback: (entry: UploadEntry) => void) => void;
  onWatcherStatus: (callback: (status: WatcherStatus) => void) => void;
  onWatchedFileChange: (callback: (filename: string | null) => void) => void;

  removeAllListeners: () => void;
  openExternal: (url: string) => Promise<void>;

  // Auto-update
  checkForUpdate: () => Promise<{ available: boolean; version?: string }>;
  installUpdate: () => Promise<void>;
  getAppVersion: () => Promise<string>;
  onUpdaterStatus: (callback: (status: UpdaterStatus) => void) => void;
}

/** Auto-updater status event */
export interface UpdaterStatus {
  status: 'available' | 'downloading' | 'ready' | 'error';
  version?: string;
  percent?: number;
  error?: string;
}

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
