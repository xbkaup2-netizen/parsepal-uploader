import { useState, useEffect, useCallback } from 'react';
import type { UploadEntry, HistoryEntry, WatcherStatus, UpdaterStatus, ScanProgress, ScannedFileGroup } from '../../shared/types';

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
  if (typeof seconds !== 'number' || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFileDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function getAgeWarning(date: Date | string): string | null {
  const d = typeof date === 'string' ? new Date(date) : date;
  const daysOld = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (daysOld >= 21) return `${Math.floor(daysOld / 7)} weeks old`;
  if (daysOld >= 7) return `${Math.floor(daysOld / 7)} week${Math.floor(daysOld / 7) > 1 ? 's' : ''} old`;
  if (daysOld >= 2) return `${daysOld} days old`;
  return null;
}

export default function Dashboard({ username }: DashboardProps) {
  const [status, setStatus] = useState<WatcherStatus>('idle');
  const [watchedFile, setWatchedFile] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activeUploads, setActiveUploads] = useState<Map<string, UploadEntry>>(new Map());
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [logFileCount, setLogFileCount] = useState<number>(0);
  const [, setTick] = useState(0);
  const [updateBanner, setUpdateBanner] = useState<UpdateBannerState>({ kind: 'hidden' });

  // Scan modal state
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [scannedGroups, setScannedGroups] = useState<ScannedFileGroup[]>([]);
  const [selectedFights, setSelectedFights] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);

  // Fetch log file count on mount + when watcher status changes
  useEffect(() => {
    window.api.getLogFileCount().then(setLogFileCount).catch(() => {});
  }, [status]);

  // Check for updates on mount + subscribe to updater/scan events
  useEffect(() => {
    window.api.checkForUpdate().catch(() => {});

    window.api.onScanProgress((progress: ScanProgress) => {
      setScanProgress(progress);
    });

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

  // ── Scan modal handlers ──────────────────────────────────────────
  async function handleScanPreview() {
    setScanning(true);
    setScanProgress(null);
    setScanModalOpen(true);
    setScannedGroups([]);
    setSelectedFights(new Set());

    try {
      const groups: ScannedFileGroup[] = await window.api.scanAllPreview();
      setScannedGroups(groups);
      // Auto-select all fights by default
      const allIds = new Set<string>();
      for (const g of groups) {
        for (const f of g.fights) {
          allIds.add(f.id);
        }
      }
      setSelectedFights(allIds);
    } catch {
      // Silent fail
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  }

  function toggleFight(id: string) {
    setSelectedFights((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleFileGroup(group: ScannedFileGroup, selectAll: boolean) {
    setSelectedFights((prev) => {
      const next = new Set(prev);
      for (const f of group.fights) {
        if (selectAll) {
          next.add(f.id);
        } else {
          next.delete(f.id);
        }
      }
      return next;
    });
  }

  async function handleUploadSelected() {
    if (selectedFights.size === 0) return;
    setUploading(true);
    try {
      await window.api.uploadSelected(Array.from(selectedFights));
      const updatedHistory = await window.api.getUploadHistory();
      setHistory(updatedHistory);
      setScanModalOpen(false);
      setScannedGroups([]);
      setSelectedFights(new Set());
    } catch {
      // Silent fail
    } finally {
      setUploading(false);
    }
  }

  function closeScanModal() {
    if (!uploading) {
      setScanModalOpen(false);
      setScannedGroups([]);
      setSelectedFights(new Set());
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

  // Total fights found across all groups
  const totalScannedFights = scannedGroups.reduce((sum, g) => sum + g.fights.length, 0);

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

      {/* Scan modal overlay */}
      {scanModalOpen && (
        <div className="scan-modal-overlay" onClick={closeScanModal}>
          <div className="scan-modal" onClick={(e) => e.stopPropagation()}>
            <div className="scan-modal-header">
              <h3 className="scan-modal-title">Browse Log Files</h3>
              <button
                className="scan-modal-close"
                onClick={closeScanModal}
                disabled={uploading}
                aria-label="Close"
              >
                {'\u2715'}
              </button>
            </div>

            <div className="scan-modal-body">
              {scanning ? (
                <div className="scan-modal-scanning">
                  <div className="spinner" style={{ fontSize: '24px', color: 'var(--text-dim)' }}>{'\u21BB'}</div>
                  <div style={{ marginTop: '12px', fontSize: '14px' }}>
                    {scanProgress
                      ? `Scanning file ${scanProgress.fileIndex} of ${scanProgress.totalFiles}...`
                      : 'Scanning log files...'}
                  </div>
                  {scanProgress && scanProgress.currentFile && (
                    <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
                      {scanProgress.currentFile}
                    </div>
                  )}
                  {scanProgress && (
                    <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-dim)' }}>
                      {scanProgress.fightsFound} fight{scanProgress.fightsFound !== 1 ? 's' : ''} found so far
                    </div>
                  )}
                </div>
              ) : totalScannedFights === 0 ? (
                <div className="scan-modal-empty">
                  <div style={{ fontSize: '14px', color: 'var(--text-dim)' }}>
                    No fights found in any log files.
                  </div>
                </div>
              ) : (
                <div className="scan-modal-results">
                  {scannedGroups.map((group) => {
                    const allSelected = group.fights.every((f) => selectedFights.has(f.id));
                    const someSelected = group.fights.some((f) => selectedFights.has(f.id));
                    const ageWarning = getAgeWarning(group.sourceFileDate);

                    return (
                      <div key={group.sourceFile} className="scan-file-group">
                        <div className="scan-file-header">
                          <label className="scan-file-header-label">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              ref={(el) => {
                                if (el) el.indeterminate = someSelected && !allSelected;
                              }}
                              onChange={() => toggleFileGroup(group, !allSelected)}
                              className="scan-checkbox"
                            />
                            <span className="scan-file-name">
                              {formatFileDate(group.sourceFileDate)} — {group.sourceFile}
                            </span>
                          </label>
                          {ageWarning && (
                            <span className="scan-age-warning">{ageWarning}</span>
                          )}
                          <span className="scan-file-count">
                            {group.fights.length} fight{group.fights.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                        <ul className="scan-fight-list">
                          {group.fights.map((fight) => {
                            const fightAge = getAgeWarning(fight.sourceFileDate);
                            return (
                              <li key={fight.id} className="scan-fight-item">
                                <label className="scan-fight-label">
                                  <input
                                    type="checkbox"
                                    checked={selectedFights.has(fight.id)}
                                    onChange={() => toggleFight(fight.id)}
                                    className="scan-checkbox"
                                  />
                                  <span className={`scan-fight-badge ${fight.success ? 'kill' : 'wipe'}`}>
                                    {fight.success ? 'Kill' : 'Wipe'}
                                  </span>
                                  <span className="scan-fight-name">
                                    {fight.encounterName}
                                    {fight.keystoneLevel ? ` +${fight.keystoneLevel}` : ''}
                                  </span>
                                  <span className="scan-fight-details">
                                    {formatDuration(fight.duration)}
                                    {' \u00B7 '}
                                    {fight.playerCount} player{fight.playerCount !== 1 ? 's' : ''}
                                    {fight.type === 'mythicplus' ? ' \u00B7 M+' : ''}
                                  </span>
                                  {fightAge && (
                                    <span className="scan-fight-age">{fightAge}</span>
                                  )}
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {!scanning && totalScannedFights > 0 && (
              <div className="scan-modal-footer">
                <div className="scan-modal-footer-info">
                  {selectedFights.size} of {totalScannedFights} fight{totalScannedFights !== 1 ? 's' : ''} selected
                </div>
                <div className="scan-modal-footer-actions">
                  <button
                    className="btn btn-secondary"
                    style={{ padding: '6px 14px', fontSize: '12px' }}
                    onClick={closeScanModal}
                    disabled={uploading}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    style={{ padding: '6px 14px', fontSize: '12px' }}
                    disabled={selectedFights.size === 0 || uploading}
                    onClick={handleUploadSelected}
                  >
                    {uploading
                      ? 'Uploading...'
                      : `Upload Selected (${selectedFights.size})`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

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
            disabled={scanning}
            onClick={handleScanPreview}
          >
            {scanning
              ? scanProgress
                ? `Scanning file ${scanProgress.fileIndex} of ${scanProgress.totalFiles}...`
                : 'Scanning...'
              : logFileCount > 0
                ? `Scan All Logs (${logFileCount} file${logFileCount !== 1 ? 's' : ''})`
                : 'Scan All Logs'}
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
