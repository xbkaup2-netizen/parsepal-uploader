import { useState, useEffect } from 'react';
import type { AppSettings } from '../../shared/types';

interface SettingsProps {
  onBack: () => void;
  onLogout: () => void;
}

export default function Settings({ onBack, onLogout }: SettingsProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    window.api.getSettings().then(setSettings);
  }, []);

  async function updateSetting(patch: Partial<AppSettings>) {
    if (!settings) return;
    const updated = { ...settings, ...patch };
    setSettings(updated);
    await window.api.setSettings(patch);
  }

  async function handleChangePath() {
    const dir = await window.api.browseWowDir();
    if (dir) {
      updateSetting({ wowPath: dir });
    }
  }

  function handleLogout() {
    onLogout();
  }

  if (!settings) return null;

  return (
    <div className="content">
      <div className="section-title">WoW Directory</div>
      <div className="card">
        <div className="settings-row">
          <div>
            <div className="settings-label">Install Path</div>
            <div className="settings-sublabel">
              {settings.wowPath || 'Not set'}
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '6px 14px', fontSize: '12px' }} onClick={handleChangePath}>
            Change
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-label">Game Version</div>
          <select
            className="input"
            style={{ width: 'auto' }}
            value={settings.gameVersion}
            onChange={(e) =>
              updateSetting({
                gameVersion: e.target.value as 'retail' | 'classic',
              })
            }
          >
            <option value="retail">Retail</option>
            <option value="classic">Classic</option>
          </select>
        </div>
      </div>

      <div className="section-title" style={{ marginTop: '24px' }}>Preferences</div>
      <div className="card">
        <div className="settings-row">
          <div>
            <div className="settings-label">Auto-upload new fights</div>
            <div className="settings-sublabel">
              Automatically upload fights as they are detected
            </div>
          </div>
          <input
            type="checkbox"
            className="toggle"
            checked={settings.autoUpload}
            onChange={(e) => updateSetting({ autoUpload: e.target.checked })}
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-label">Minimize to system tray</div>
            <div className="settings-sublabel">
              Keep running in the background when closed
            </div>
          </div>
          <input
            type="checkbox"
            className="toggle"
            checked={settings.minimizeToTray}
            onChange={(e) =>
              updateSetting({ minimizeToTray: e.target.checked })
            }
          />
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-label">Launch on startup</div>
            <div className="settings-sublabel">
              Start ParsePal when Windows starts
            </div>
          </div>
          <input
            type="checkbox"
            className="toggle"
            checked={settings.launchOnStartup}
            onChange={(e) =>
              updateSetting({ launchOnStartup: e.target.checked })
            }
          />
        </div>
      </div>

      <div className="section-title" style={{ marginTop: '24px' }}>Account</div>
      <div className="card">
        <div className="settings-row">
          <div>
            <div className="settings-label">{settings.username}</div>
            <div className="settings-sublabel">Logged in</div>
          </div>
          <button
            className="btn btn-secondary"
            style={{ padding: '6px 14px', fontSize: '12px' }}
            onClick={handleLogout}
          >
            Log Out
          </button>
        </div>
      </div>

      <div
        className="text-center mt-16"
        style={{ color: 'var(--text-muted)', fontSize: '12px' }}
      >
        ParsePal Uploader v1.0.0
      </div>
    </div>
  );
}
