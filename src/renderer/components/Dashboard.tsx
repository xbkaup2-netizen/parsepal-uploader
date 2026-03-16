import { useState, useEffect, useCallback } from 'react';
import type { UploadEntry, HistoryEntry, WatcherStatus, UpdaterStatus } from '../../shared/types';

interface DashboardProps {
  username: string;
}

type UpdateBannerState =
  | { kind: 'hidden' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function Dashboard({ username }: DashboardProps) {
  const [status, setStatus] = useState<WatcherStatus>('idle');
  const [watchedFile, setWatchedFile] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activeUploads, setActiveUploads] = useState<Map<string, UploadEntry>>(new Map());
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [, setTick] = useState(0);
  const [updateBanner, setUpdateBanner] = useState<UpdateBannerState>({ kind: 'hidden' });

  // Check for updates on mount + subscribe to updater events
  useEffect(() => {
    window.api.checkForUpdate().catch(() => {});

    window.api.onUpdaterStatus((evt: UpdaterStatus) => {
      switch (evt.status) {
        case 'available':
          setUpdateBanner({ kind: 'available', version: evt.version ?? '' });
          break;
        case 'downloading':
          setUpdateBanner((prev) =>
            prev.kind === 'hidden' ? prev : { kind: 'downloading', version: (prev as any).version ?? '', percent: evt.percent ?? 0 },
          );
          break;
        case 'ready':
          setUpdateBanner((prev) => ({
            kind: 'ready',
            version: (prev as any).version ?? evt.version ?? '',
          }));
          break;
        case 'error':
          setUpdateBanner({ kind: 'error', message: evt.error ?? 'Update failed' });
          break;
      }
    });

    // Cleanup handled by existing removeAllListeners in the other useEffect
  }, []);

  // Force re-render every 30s to update "time ago" labels
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(interval);
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [watcherStatus, currentFile, uploadHistory] = await Promise.all([
        window.api.getWatcherStatus(),
        window.api.getWatchedFile(),
        window.api.getUploadHistory(),
      ]);
      setStatus(watcherStatus);
      setWatchedFile(currentFile);
      setHistory(uploadHistory);
      if (uploadHistory.length > 0) {
        setLastUpdate(uploadHistory[0].timestamp);
      }
    } catch {
      // Silent fail on load
    }
  }, []);

  useEffect(() => {
    loadData();

    window.api.onFightDetected((entry: UploadEntry) => {
      setActiveUploads((prev) => {
        const next = new Map(prev);
        next.set(entry.id, entry);
        return next;
      });
      setLastUpdate(Date.now());
    });

    window.api.onUploadProgress((entry: UploadEntry) => {
      if (entry.status === 'done' || entry.status === 'error') {
        setActiveUploads((prev) => {
          const next = new Map(prev);
          next.delete(entry.id);
          return next;
        });
        // Refresh history to get the completed entry
        window.api.getUploadHistory().then(setHistory);
      } else {
        setActiveUploads((prev) => {
          const next = new Map(prev);
          next.set(entry.id, entry);
          return next;
        });
      }
    });

    window.api.onWatcherStatus((newStatus: WatcherStatus) => {
      setStatus(newStatus);
    });

    window.api.onWatchedFileChange((filename: string | null) => {
      setWatchedFile(filename);
    });

    return () => {
      window.api.removeAllListeners();
    };
  }, [loadData]);

  async function handlePauseResume() {
    try {
      if (status === 'watching' || status === 'waiting') {
        await window.api.stopWatcher();
      } else {
        await window.api.startWatcher();
      }
    } catch {
      // Handle error silently
    }
  }

  function getStatusLabel(s: WatcherStatus): string {
    switch (s) {
      case 'watching': return 'Watching';
      case 'waiting': return 'Waiting for combat log...';
      case 'paused': return 'Paused';
      case 'error': return 'Error';
      default: return 'Idle';
    }
  }

  // Count tonight's fights (since midnight)
  const midnightToday = new Date();
  midnightToday.setHours(0, 0, 0, 0);
  const tonightCount = history.filter(
    (h) => h.timestamp >= midnightToday.getTime()
  ).length + activeUploads.size;

  // Merge active uploads into display list
  const activeEntries = Array.from(activeUploads.values());

  return (
    <>
      {/* Auto-update banner */}
      {updateBanner.kind === 'available' && (
        <div className="update-banner">
          <span>
            ParsePal v{updateBanner.version} is available
          </span>
          <button
            className="btn btn-primary"
            style={{ padding: '4px 12px', fontSize: '12px' }}
            onClick={() => {
              setUpdateBanner({ kind: 'downloading', version: updateBanner.version, percent: 0 });
              window.api.installUpdate();
            }}
          >
            Download &amp; Install
          </button>
          <button
            className="update-banner-dismiss"
            onClick={() => setUpdateBanner({ kind: 'hidden' })}
            aria-label="Dismiss"
          >
            {'\u2715'}
          </button>
        </div>
      )}

      {updateBanner.kind === 'downloading' && (
        <div className="update-banner">
          <span>Downloading v{updateBanner.version}...</span>
          <div className="update-progress-track">
            <div
              className="update-progress-bar"
              style={{ width: `${Math.round(updateBanner.percent)}%` }}
            />
          </div>
          <span className="update-percent">{Math.round(updateBanner.percent)}%</span>
        </div>
      )}

      {updateBanner.kind === 'ready' && (
        <div className="update-banner update-banner-ready">
          <span>v{updateBanner.version} downloaded — restart to finish.</span>
          <button
            className="btn btn-primary"
            style={{ padding: '4px 12px', fontSize: '12px' }}
            onClick={() => window.api.installUpdate()}
          >
            Restart Now
          </button>
          <button
            className="update-banner-dismiss"
            onClick={() => setUpdateBanner({ kind: 'hidden' })}
            aria-label="Dismiss"
          >
            {'\u2715'}
          </button>
        </div>
      )}

      {updateBanner.kind === 'error' && (
        <div className="update-banner update-banner-error">
          <span>Update error: {updateBanner.message}</span>
          <button
            className="update-banner-dismiss"
            onClick={() => setUpdateBanner({ kind: 'hidden' })}
            aria-label="Dismiss"
          >
            {'\u2715'}
          </button>
        </div>
      )}

      <div className="content">
        {/* Status card */}
        <div className="card">
          <div className="dashboard-status">
            <span className={`status-dot ${status}`} />
            <span className="dashboard-status-text">{getStatusLabel(status)}</span>
          </div>
          <div className="dashboard-status-file">
            {status === 'waiting'
              ? 'Waiting for WoWCombatLog...'
              : watchedFile || 'WoWCombatLog.txt'}
          </div>
          {lastUpdate && (
            <div className="dashboard-status-time">
              Last updated: {formatTimeAgo(lastUpdate)}
            </div>
          )}
        </div>

        {/* Fight list */}
        <div className="dashboard-fights-header">
          <span className="section-title">Recent Uploads</span>
        </div>

        {activeEntries.length === 0 && history.length === 0 ? (
          <div className="dashboard-empty">
            <div className="dashboard-empty-icon">{'\u2694'}</div>
            <div>No fights uploaded yet.</div>
            <div style={{ marginTop: '4px', color: 'var(--text-muted)', fontSize: '12px' }}>
              Start a raid or dungeon and fights will appear here automatically.
            </div>
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <ul className="fight-list">
              {/* Active uploads first */}
              {activeEntries.map((entry) => (
                <li key={entry.id} className="fight-item">
                  <span className="fight-icon uploading">
                    <span className="spinner">{'\u21BB'}</span>
                  </span>
                  <div className="fight-info">
                    <div className="fight-name">
                      {entry.fight.encounterName}
                      {entry.fight.keystoneLevel
                        ? ` +${entry.fight.keystoneLevel}`
                        : entry.fight.success
                          ? ' (Kill)'
                          : ' (Wipe)'}
                    </div>
                    <div className="fight-meta">
                      {formatDuration(entry.fight.duration)} — Uploading...
                    </div>
                  </div>
                </li>
              ))}

              {/* Completed history */}
              {history.map((entry) => (
                <li key={entry.id} className="fight-item">
                  <span className={`fight-icon ${entry.status === 'done' ? 'success' : 'error'}`}>
                    {entry.status === 'done' ? '\u2713' : '\u2717'}
                  </span>
                  <div className="fight-info">
                    <div className="fight-name">
                      {entry.encounterName}
                      {entry.keystoneLevel
                        ? ` +${entry.keystoneLevel}`
                        : entry.success
                          ? ' (Kill)'
                          : ' (Wipe)'}
                    </div>
                    <div className="fight-meta">
                      {formatDuration(entry.duration)} — {formatTimeAgo(entry.timestamp)}
                    </div>
                  </div>
                  <div className="fight-action">
                    {entry.status === 'done' && entry.analysisUrl && (
                      <a
                        className="link"
                        onClick={() => window.api.openExternal(entry.analysisUrl!)}
                      >
                        View Analysis
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="bottom-bar">
        <div className="bottom-bar-stat">
          Tonight: <strong>{tonightCount}</strong> fight{tonightCount !== 1 ? 's' : ''} uploaded
        </div>
        <div className="bottom-bar-actions">
          <a
            className="link"
            onClick={() => window.api.openExternal('https://parsepal.gg')}
          >
            Open parsepal.gg
          </a>
          <button
            className="btn btn-secondary"
            style={{ padding: '6px 14px', fontSize: '12px' }}
            disabled={scanning || status !== 'watching'}
            onClick={async () => {
              setScanning(true);
              try {
                await window.api.scanExisting();
                const updatedHistory = await window.api.getUploadHistory();
                setHistory(updatedHistory);
              } catch {
                // Silent fail
              } finally {
                setScanning(false);
              }
            }}
          >
            {scanning ? 'Scanning...' : 'Scan Existing Logs'}
          </button>
          <button
            className="btn btn-secondary"
            style={{ padding: '6px 14px', fontSize: '12px' }}
            onClick={handlePauseResume}
          >
            {status === 'watching' || status === 'waiting' ? 'Pause' : 'Resume'}
          </button>
        </div>
      </div>
    </>
  );
}
