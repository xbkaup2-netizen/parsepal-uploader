import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as chokidar from 'chokidar';
import * as readline from 'readline';
import { LogParser } from './logParser';
import type { Fight, WatcherStatus, ScanProgress, ScannedFight, ScannedFileGroup } from '../shared/types';

export type { ScanProgress };

const LOG_GLOB = 'WoWCombatLog';

/**
 * Watches the WoW Logs directory for WoWCombatLog*.txt files.
 * Automatically picks the most recently modified file and switches
 * to new files as WoW creates them (timestamped filenames).
 */
export class FileWatcher {
  public readonly logsDir: string;
  private logPath: string | null = null;
  private parser: LogParser;
  private onFight: (fight: Fight) => void;
  private fileWatcher: chokidar.FSWatcher | null = null;
  private dirWatcher: chokidar.FSWatcher | null = null;
  private offset: number = 0;
  private status: WatcherStatus = 'idle';
  private processing: boolean = false;
  public onStatus: (status: WatcherStatus) => void = () => {};
  public onFileChange: (filename: string | null) => void = () => {};

  constructor(wowPath: string, gameVersion: string, onFight: (fight: Fight) => void) {
    this.logsDir = path.join(wowPath, `_${gameVersion}_`, 'Logs');
    this.onFight = onFight;
    this.parser = new LogParser(onFight);
  }

  /**
   * Find the most recently modified WoWCombatLog*.txt in the Logs dir.
   */
  private findLatestLog(): string | null {
    if (!fs.existsSync(this.logsDir)) return null;

    let latest: string | null = null;
    let latestMtime = 0;

    try {
      const files = fs.readdirSync(this.logsDir);
      for (const f of files) {
        if (!f.startsWith(LOG_GLOB) || !f.endsWith('.txt')) continue;
        const fullPath = path.join(this.logsDir, f);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > latestMtime) {
            latestMtime = stat.mtimeMs;
            latest = fullPath;
          }
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // Directory read error
    }

    return latest;
  }

  /**
   * Return the filename currently being watched (just the basename).
   */
  getWatchedFile(): string | null {
    return this.logPath ? path.basename(this.logPath) : null;
  }

  async start(): Promise<void> {
    try {
      // Find the latest combat log file
      this.logPath = this.findLatestLog();

      if (this.logPath) {
        const stat = fs.statSync(this.logPath);
        this.offset = stat.size;
        this.onFileChange(path.basename(this.logPath));
        this.watchFile();
        this.setStatus('watching');
      } else {
        this.offset = 0;
        this.onFileChange(null);
        this.setStatus('waiting');
      }

      // Always watch the directory for new combat log files
      this.watchDirectory();
    } catch (err) {
      console.error('Failed to start watcher:', err);
      this.setStatus('error');
    }
  }

  /**
   * Start watching the current logPath for content changes.
   */
  private watchFile(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (!this.logPath) return;

    this.fileWatcher = chokidar.watch(this.logPath, {
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 50 },
      ignoreInitial: true,
    });

    this.fileWatcher.on('change', () => this.readNewContent());
    this.fileWatcher.on('add', () => {
      this.offset = 0;
      this.readNewContent();
    });
    this.fileWatcher.on('error', (err) => {
      console.error('File watcher error:', err);
    });
  }

  /**
   * Watch the Logs directory for new WoWCombatLog*.txt files.
   * When a new one appears, switch to watching it.
   */
  private watchDirectory(): void {
    // Ensure directory exists so chokidar doesn't error
    if (!fs.existsSync(this.logsDir)) {
      try {
        fs.mkdirSync(this.logsDir, { recursive: true });
      } catch {
        return;
      }
    }

    this.dirWatcher = chokidar.watch(this.logsDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
    });

    this.dirWatcher.on('add', (filePath: string) => {
      const basename = path.basename(filePath);
      if (!basename.startsWith(LOG_GLOB) || !basename.endsWith('.txt')) return;

      // New combat log file appeared — switch to it
      console.log(`New combat log detected: ${basename}`);
      this.switchToFile(filePath);
    });

    this.dirWatcher.on('error', (err) => {
      console.error('Directory watcher error:', err);
    });
  }

  /**
   * Switch the active watched file to a new path.
   * Resets the offset to 0 and creates a fresh parser.
   */
  private async switchToFile(newPath: string): Promise<void> {
    if (this.logPath === newPath) return;

    this.logPath = newPath;
    this.offset = 0;
    this.parser = new LogParser(this.onFight);
    this.onFileChange(path.basename(newPath));

    this.watchFile();
    this.setStatus('watching');

    // Read any initial content already in the new file
    await this.readNewContent();
  }

  /**
   * Scan existing file content from offset 0 to detect fights already in the log.
   * Does NOT affect the live watcher offset.
   */
  async scanExisting(): Promise<number> {
    if (!this.logPath || !fs.existsSync(this.logPath)) return 0;
    if (this.processing) return 0;
    this.processing = true;

    let fightCount = 0;
    const parser = new LogParser((fight) => {
      fightCount++;
      this.onFight(fight);
    });

    try {
      const stream = fs.createReadStream(this.logPath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        parser.processLine(line);
      }
    } catch (err) {
      console.error('Error scanning existing log:', err);
    } finally {
      this.processing = false;
    }

    // Pick up any content written while scanExisting held the processing lock
    await this.readNewContent();

    return fightCount;
  }

  /**
   * List all WoWCombatLog*.txt files in the Logs directory, newest first.
   */
  listAllLogs(): { name: string; fullPath: string; mtimeMs: number }[] {
    if (!fs.existsSync(this.logsDir)) return [];
    try {
      const files = fs.readdirSync(this.logsDir);
      const logFiles: { name: string; fullPath: string; mtimeMs: number }[] = [];
      for (const f of files) {
        if (!f.startsWith(LOG_GLOB) || !f.endsWith('.txt')) continue;
        const fullPath = path.join(this.logsDir, f);
        try {
          const stat = fs.statSync(fullPath);
          logFiles.push({ name: f, fullPath, mtimeMs: stat.mtimeMs });
        } catch {
          // Skip files we can't stat
        }
      }
      logFiles.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
      return logFiles;
    } catch {
      return [];
    }
  }

  /**
   * Scan ALL WoWCombatLog*.txt files (newest first) and emit detected fights.
   * Reports progress via the optional callback. Does NOT affect the live watcher.
   */
  async scanAllLogs(
    onProgress?: (progress: ScanProgress) => void,
    seenFights?: Set<string>,
  ): Promise<number> {
    const logFiles = this.listAllLogs();
    if (logFiles.length === 0) return 0;

    let totalFights = 0;
    const seen = seenFights ?? new Set<string>();

    for (let i = 0; i < logFiles.length; i++) {
      const logFile = logFiles[i];
      onProgress?.({
        currentFile: logFile.name,
        fileIndex: i + 1,
        totalFiles: logFiles.length,
        fightsFound: totalFights,
      });

      const parser = new LogParser((fight) => {
        // Deduplicate by encounter name + start time
        const key = `${fight.encounterName}|${fight.startTime}`;
        if (seen.has(key)) return;
        seen.add(key);
        totalFights++;
        this.onFight(fight);
      });

      try {
        const stream = fs.createReadStream(logFile.fullPath, { encoding: 'utf-8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        for await (const line of rl) {
          parser.processLine(line);
        }
      } catch (err) {
        console.error(`Error scanning ${logFile.name}:`, err);
      }
    }

    onProgress?.({
      currentFile: '',
      fileIndex: logFiles.length,
      totalFiles: logFiles.length,
      fightsFound: totalFights,
    });

    return totalFights;
  }

  /**
   * Scan ALL WoWCombatLog*.txt files and return detected fights grouped by file.
   * Does NOT call onFight — purely returns data for the UI to display.
   */
  async scanAllLogsPreview(
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<ScannedFileGroup[]> {
    const logFiles = this.listAllLogs();
    if (logFiles.length === 0) return [];

    const groups: ScannedFileGroup[] = [];
    const seen = new Set<string>();
    let totalFights = 0;

    for (let i = 0; i < logFiles.length; i++) {
      const logFile = logFiles[i];
      onProgress?.({
        currentFile: logFile.name,
        fileIndex: i + 1,
        totalFiles: logFiles.length,
        fightsFound: totalFights,
      });

      const fights: ScannedFight[] = [];
      const sourceFileDate = new Date(logFile.mtimeMs);

      const parser = new LogParser((fight: Fight) => {
        const key = `${fight.encounterName}|${fight.startTime}`;
        if (seen.has(key)) return;
        seen.add(key);
        totalFights++;

        fights.push({
          id: crypto.randomUUID(),
          encounterName: fight.encounterName,
          type: fight.type,
          success: fight.success,
          duration: typeof fight.duration === 'number' && !isNaN(fight.duration) ? fight.duration : 0,
          keystoneLevel: fight.keystoneLevel,
          playerCount: fight.playerCount,
          startTime: fight.startTime,
          sourceFile: logFile.name,
          sourceFileDate,
          lines: fight.lines,
          fileSize: fight.fileSize,
        });
      });

      try {
        const stream = fs.createReadStream(logFile.fullPath, { encoding: 'utf-8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        for await (const line of rl) {
          parser.processLine(line);
        }
      } catch (err) {
        console.error(`Error scanning ${logFile.name}:`, err);
      }

      if (fights.length > 0) {
        groups.push({
          sourceFile: logFile.name,
          sourceFileDate,
          fights,
        });
      }
    }

    onProgress?.({
      currentFile: '',
      fileIndex: logFiles.length,
      totalFiles: logFiles.length,
      fightsFound: totalFights,
    });

    return groups;
  }

  /**
   * Given an array of ScannedFight objects, upload each one via the onFight callback.
   * Returns the count of fights dispatched.
   */
  uploadScannedFights(fights: ScannedFight[]): number {
    let count = 0;
    for (const sf of fights) {
      const fight: Fight = {
        type: sf.type,
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
      this.onFight(fight);
      count++;
    }
    return count;
  }

  async stop(): Promise<void> {
    if (this.fileWatcher) {
      await this.fileWatcher.close();
      this.fileWatcher = null;
    }
    if (this.dirWatcher) {
      await this.dirWatcher.close();
      this.dirWatcher = null;
    }
    this.setStatus('idle');
  }

  getStatus(): WatcherStatus {
    return this.status;
  }

  private setStatus(status: WatcherStatus): void {
    this.status = status;
    this.onStatus(status);
  }

  private async readNewContent(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      if (!this.logPath || !fs.existsSync(this.logPath)) {
        this.processing = false;
        return;
      }

      const stat = fs.statSync(this.logPath);
      if (stat.size < this.offset) {
        this.offset = 0;
      }
      if (stat.size <= this.offset) {
        this.processing = false;
        return;
      }

      const stream = fs.createReadStream(this.logPath, {
        start: this.offset,
        encoding: 'utf-8',
      });

      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        this.parser.processLine(line);
      }

      this.offset = stat.size;
    } catch (err) {
      console.error('Error reading log:', err);
    } finally {
      this.processing = false;
    }
  }
}
