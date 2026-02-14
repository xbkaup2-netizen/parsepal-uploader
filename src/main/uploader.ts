import * as https from 'https';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import type { Fight, UploadEntry, UploadResponse } from '../shared/types';

const API_BASE = 'https://parsepal-production.up.railway.app';
const MAX_UNCOMPRESSED = 1024 * 1024; // 1MB

/**
 * HTTP client that uploads fight data to the ParsePal API.
 * Queues fights and processes them sequentially with retry logic.
 */
export class Uploader {
  private getToken: () => string;
  private queue: { fight: Fight; entry: UploadEntry }[] = [];
  private processing: boolean = false;
  public onProgress: (entry: UploadEntry) => void = () => {};

  constructor(getToken: () => string) {
    this.getToken = getToken;
  }

  uploadFight(fight: Fight): UploadEntry {
    const entry: UploadEntry = {
      id: crypto.randomUUID(),
      fight: {
        type: fight.type,
        encounterName: fight.encounterName,
        duration: fight.duration,
        success: fight.success,
        keystoneLevel: fight.keystoneLevel,
      },
      status: 'queued',
      progress: 0,
      timestamp: Date.now(),
    };
    this.queue.push({ fight, entry });
    this.onProgress(entry);
    this.processQueue();
    return entry;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      await this.doUpload(item.fight, item.entry);
    }

    this.processing = false;
  }

  private async doUpload(fight: Fight, entry: UploadEntry): Promise<void> {
    entry.status = 'uploading';
    entry.progress = 10;
    this.onProgress(entry);

    const logData = fight.lines.join('\n');
    let fileBuffer = Buffer.from(logData, 'utf-8');
    let filename = 'fight.txt';

    if (fileBuffer.length > MAX_UNCOMPRESSED) {
      fileBuffer = zlib.gzipSync(fileBuffer);
      filename = 'fight.txt.gz';
    }

    const metadata = JSON.stringify({
      type: fight.type,
      encounterName: fight.encounterName,
      encounterID: fight.encounterID,
      duration: fight.duration,
      success: fight.success,
      keystoneLevel: fight.keystoneLevel,
      playerCount: fight.playerCount,
    });

    const delays = [1000, 2000, 4000];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        entry.progress = 30 + attempt * 20;
        this.onProgress(entry);

        const result = await this.postMultipart(fileBuffer, filename, metadata);
        entry.status = 'done';
        entry.progress = 100;
        if (result.analysis_url) {
          entry.analysisUrl = result.analysis_url;
        }
        this.onProgress(entry);
        return;
      } catch (err: any) {
        if (attempt < 2) {
          await this.sleep(delays[attempt]);
        } else {
          entry.status = 'error';
          entry.error = err.message || 'Upload failed';
          entry.progress = 0;
          this.onProgress(entry);
        }
      }
    }
  }

  private postMultipart(fileBuffer: Buffer, filename: string, metadata: string): Promise<UploadResponse> {
    return new Promise((resolve, reject) => {
      const token = this.getToken();
      const boundary = '----ParsePal' + crypto.randomBytes(16).toString('hex');
      const crlf = '\r\n';

      const parts: Buffer[] = [];

      // File field
      parts.push(Buffer.from(
        `--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}` +
        `Content-Type: application/octet-stream${crlf}${crlf}`
      ));
      parts.push(fileBuffer);
      parts.push(Buffer.from(crlf));

      // Metadata field
      parts.push(Buffer.from(
        `--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="metadata"${crlf}` +
        `Content-Type: application/json${crlf}${crlf}`
      ));
      parts.push(Buffer.from(metadata));
      parts.push(Buffer.from(crlf));

      // Closing boundary
      parts.push(Buffer.from(`--${boundary}--${crlf}`));

      const body = Buffer.concat(parts);

      const url = new URL(`${API_BASE}/api/upload/desktop`);
      const options: https.RequestOptions = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          try {
            const data = JSON.parse(raw);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data as UploadResponse);
            } else {
              reject(new Error(data.detail || data.message || `HTTP ${res.statusCode}`));
            }
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
