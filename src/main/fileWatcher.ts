import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import * as readline from 'readline';
import { LogParser } from './logParser';
import type { Fight, WatcherStatus } from '../shared/types';

const LOG_GLOB = 'WoWCombatLog';

/**
 * Watches the WoW Logs directory for WoWCombatLog*.txt files.
 * Automatically picks the most recently modified file and switches
 * to new files as WoW creates them (timestamped filenames).
 */
export class FileWatcher {
  private logsDir: string;
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
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
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

    return fightCount;
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
