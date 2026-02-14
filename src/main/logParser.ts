import type { Fight } from '../shared/types';

/**
 * Parses WoW combat log lines and groups them into discrete fights.
 * Handles both raid encounters (ENCOUNTER_START/END) and M+ runs
 * (CHALLENGE_MODE_START/END), nesting boss encounters within M+ runs.
 */
export class LogParser {
  private onFight: (fight: Fight) => void;
  private lines: string[] = [];
  private startTime: string = '';
  private encounterName: string = '';
  private encounterID: number = 0;
  private inEncounter: boolean = false;
  private mplusLines: string[] = [];
  private mplusStartTime: string = '';
  private mplusDungeonName: string = '';
  private mplusKeystoneLevel: number = 0;
  private inMplus: boolean = false;

  constructor(onFight: (fight: Fight) => void) {
    this.onFight = onFight;
  }

  processLine(line: string): void {
    if (!line.trim()) return;

    const tsEnd = line.indexOf('  ');
    if (tsEnd === -1) return;
    const timestamp = line.substring(0, tsEnd);
    const payload = line.substring(tsEnd + 2);

    if (payload.startsWith('COMBAT_LOG_VERSION')) {
      this.reset();
      return;
    }

    if (payload.startsWith('CHALLENGE_MODE_START')) {
      this.inMplus = true;
      this.mplusLines = [line];
      this.mplusStartTime = timestamp;
      const parts = this.splitCSV(payload);
      this.mplusDungeonName = parts[1]?.replace(/"/g, '') || 'Unknown Dungeon';
      this.mplusKeystoneLevel = parseInt(parts[4], 10) || 0;
      return;
    }

    if (payload.startsWith('CHALLENGE_MODE_END') && this.inMplus) {
      this.mplusLines.push(line);
      const parts = this.splitCSV(payload);
      const success = parts[2] === '1';
      const duration = this.calcDuration(this.mplusStartTime, timestamp);
      const playerCount = this.countPlayers(this.mplusLines);
      const fileSize = this.mplusLines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf-8') + 1, 0);
      this.onFight({
        type: 'mythicplus',
        encounterName: this.mplusDungeonName,
        encounterID: 0,
        startTime: this.mplusStartTime,
        endTime: timestamp,
        duration,
        success,
        keystoneLevel: this.mplusKeystoneLevel,
        lines: this.mplusLines,
        playerCount,
        fileSize,
      });
      this.inMplus = false;
      this.mplusLines = [];
      this.inEncounter = false;
      this.lines = [];
      return;
    }

    if (this.inMplus) {
      this.mplusLines.push(line);
    }

    if (payload.startsWith('ENCOUNTER_START')) {
      this.inEncounter = true;
      this.lines = [line];
      this.startTime = timestamp;
      const parts = this.splitCSV(payload);
      this.encounterID = parseInt(parts[1], 10) || 0;
      this.encounterName = parts[2]?.replace(/"/g, '') || 'Unknown';
      return;
    }

    if (payload.startsWith('ENCOUNTER_END') && this.inEncounter) {
      this.lines.push(line);
      const parts = this.splitCSV(payload);
      const success = parts[5] === '1';
      const duration = this.calcDuration(this.startTime, timestamp);
      const playerCount = this.countPlayers(this.lines);
      const fileSize = this.lines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf-8') + 1, 0);
      this.inEncounter = false;
      if (!this.inMplus) {
        this.onFight({
          type: 'raid',
          encounterName: this.encounterName,
          encounterID: this.encounterID,
          startTime: this.startTime,
          endTime: timestamp,
          duration,
          success,
          lines: this.lines,
          playerCount,
          fileSize,
        });
      }
      this.lines = [];
      return;
    }

    if (this.inEncounter) {
      this.lines.push(line);
    }
  }

  private reset(): void {
    this.inEncounter = false;
    this.inMplus = false;
    this.lines = [];
    this.mplusLines = [];
  }

  private splitCSV(payload: string): string[] {
    return payload.split(',');
  }

  private countPlayers(lines: string[]): number {
    const guids = new Set<string>();
    const playerRegex = /Player-[0-9A-F]+-[0-9A-F]+/g;
    for (const line of lines) {
      const matches = line.match(playerRegex);
      if (matches) {
        for (const m of matches) guids.add(m);
      }
    }
    return guids.size;
  }

  private calcDuration(start: string, end: string): number {
    const toMs = (ts: string): number => {
      const [datePart, timePart] = ts.split(' ');
      const [month, day] = datePart.split('/').map(Number);
      const [h, m, rest] = timePart.split(':');
      const [s, ms] = rest.split('.');
      return new Date(2000, month - 1, day, +h, +m, +s, +ms).getTime();
    };
    return Math.round((toMs(end) - toMs(start)) / 1000);
  }
}
