import { useState, useEffect } from 'react';

interface SetupProps {
  onComplete: () => void;
}

export default function Setup({ onComplete }: SetupProps) {
  const [wowPath, setWowPath] = useState('');
  const [gameVersion, setGameVersion] = useState<'retail' | 'classic'>('retail');
  const [pathValid, setPathValid] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function detect() {
      try {
        const detected = await window.api.detectWowDir();
        if (detected) {
          setWowPath(detected);
        }
      } catch {
        // Detection failed, user can browse manually
      }
    }
    detect();
  }, []);

  useEffect(() => {
    if (!wowPath) {
      setPathValid(null);
      return;
    }

    // Validate by attempting to save and checking - we do a quick heuristic
    // based on whether the path looks correct (contains the expected structure)
    async function validate() {
      try {
        await window.api.setSettings({ wowPath, gameVersion });
        setPathValid(true);
      } catch {
        setPathValid(false);
      }
    }

    const timer = setTimeout(validate, 300);
    return () => clearTimeout(timer);
  }, [wowPath, gameVersion]);

  async function handleBrowse() {
    try {
      const dir = await window.api.browseWowDir();
      if (dir) {
        setWowPath(dir);
      }
    } catch {
      // Browse cancelled
    }
  }

  async function handleStart() {
    setLoading(true);
    try {
      await window.api.setSettings({ wowPath, gameVersion });
      await window.api.startWatcher();
      onComplete();
    } catch {
      setPathValid(false);
      setLoading(false);
    }
  }

  const versionFolder = gameVersion === 'retail' ? '_retail_' : '_classic_';

  return (
    <div className="content">
      <div className="setup-wrapper">
        <div className="setup-content">
          <div className="setup-title">Set Up Log Watching</div>
          <div className="setup-subtitle">
            Point ParsePal to your World of Warcraft installation directory.
          </div>

          <div className="setup-field">
            <div className="setup-field-label">WoW Install Directory</div>
            <div className="setup-path-row">
              <input
                className="input"
                type="text"
                placeholder="C:\Program Files\World of Warcraft"
                value={wowPath}
                onChange={(e) => setWowPath(e.target.value)}
              />
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handleBrowse}
              >
                Browse
              </button>
            </div>
          </div>

          <div className="setup-field">
            <div className="setup-field-label">Game Version</div>
            <div className="version-options">
              <label className="version-option">
                <input
                  type="radio"
                  name="version"
                  value="retail"
                  checked={gameVersion === 'retail'}
                  onChange={() => setGameVersion('retail')}
                />
                Retail
              </label>
              <label className="version-option">
                <input
                  type="radio"
                  name="version"
                  value="classic"
                  checked={gameVersion === 'classic'}
                  onChange={() => setGameVersion('classic')}
                />
                Classic
              </label>
            </div>
          </div>

          {wowPath && (
            <div className={`setup-status ${pathValid ? 'valid' : 'invalid'}`}>
              {pathValid === true && (
                <>
                  {'\u2713'} Will watch: {wowPath}/{versionFolder}/Logs/WoWCombatLog.txt
                </>
              )}
              {pathValid === false && (
                <>
                  {'\u2717'} Could not validate path. Make sure this is your WoW install folder.
                </>
              )}
              {pathValid === null && (
                <>Checking path...</>
              )}
            </div>
          )}

          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={!pathValid || loading}
            onClick={handleStart}
          >
            {loading ? 'Starting...' : 'Start Watching'}
          </button>
        </div>
      </div>
    </div>
  );
}
