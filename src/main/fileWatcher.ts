import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import * as readline from 'readline';
import { LogParser } from './logParser';
import type { Fight, WatcherStatus } from '../shared/types';

/**
 * Watches WoWCombatLog.txt for new content using chokidar.
 * Only reads newly appended bytes, feeding them into a LogParser.
 */
export class FileWatcher {
  private logPath: string;
  private parser: LogParser;
  private watcher: chokidar.FSWatcher | null = null;
  private offset: number = 0;
  private status: WatcherStatus = 'idle';
  private processing: boolean = false;
  public onStatus: (status: WatcherStatus) => void = () => {};

  constructor(wowPath: string, gameVersion: string, onFight: (fight: Fight) => void) {
    this.logPath = path.join(wowPath, `_${gameVersion}_`, 'Logs', 'WoWCombatLog.txt');
    this.parser = new LogParser(onFight);
  }

  async start(): Promise<void> {
    try {
      if (fs.existsSync(this.logPath)) {
        const stat = fs.statSync(this.logPath);
        this.offset = stat.size;
      } else {
        this.offset = 0;
      }

      this.watcher = chokidar.watch(this.logPath, {
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        ignoreInitial: true,
      });

      this.watcher.on('change', () => this.readNewContent());
      this.watcher.on('add', () => {
        this.offset = 0;
        this.readNewContent();
      });
      this.watcher.on('error', (err) => {
        console.error('Watcher error:', err);
        this.setStatus('error');
      });

      this.setStatus('watching');
    } catch (err) {
      console.error('Failed to start watcher:', err);
      this.setStatus('error');
    }
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
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
      if (!fs.existsSync(this.logPath)) {
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
