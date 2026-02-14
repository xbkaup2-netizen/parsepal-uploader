import { useState, useEffect } from 'react';
import Login from './components/Login';
import Setup from './components/Setup';
import Dashboard from './components/Dashboard';
import Settings from './components/Settings';

type Screen = 'loading' | 'login' | 'setup' | 'dashboard' | 'settings';

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [username, setUsername] = useState<string>('');

  useEffect(() => {
    async function init() {
      try {
        const auth = await window.api.getAuthState();
        if (!auth.loggedIn) {
          setScreen('login');
          return;
        }
        setUsername(auth.username);
        const settings = await window.api.getSettings();
        if (!settings.wowPath) {
          setScreen('setup');
        } else {
          setScreen('dashboard');
        }
      } catch {
        setScreen('login');
      }
    }
    init();
  }, []);

  function handleLoginSuccess(name: string) {
    setUsername(name);
    window.api.getSettings().then((settings) => {
      if (!settings.wowPath) {
        setScreen('setup');
      } else {
        setScreen('dashboard');
      }
    });
  }

  function handleSetupComplete() {
    setScreen('dashboard');
  }

  function handleLogout() {
    window.api.logout().then(() => {
      setUsername('');
      setScreen('login');
    });
  }

  function renderContent() {
    switch (screen) {
      case 'loading':
        return null;
      case 'login':
        return <Login onSuccess={handleLoginSuccess} />;
      case 'setup':
        return <Setup onComplete={handleSetupComplete} />;
      case 'dashboard':
        return <Dashboard username={username} />;
      case 'settings':
        return (
          <Settings
            onBack={() => setScreen('dashboard')}
            onLogout={handleLogout}
          />
        );
      default:
        return null;
    }
  }

  function renderHeaderActions() {
    if (screen === 'dashboard') {
      return (
        <div className="header-actions">
          <button
            className="header-btn"
            onClick={() => setScreen('settings')}
            title="Settings"
          >
            {'\u2699'}
          </button>
        </div>
      );
    }
    if (screen === 'settings') {
      return (
        <div className="header-actions">
          <button
            className="header-btn"
            onClick={() => setScreen('dashboard')}
            title="Back"
          >
            {'\u2190'}
          </button>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="app">
      <div className="header">
        <div className="header-title">
          <span className="header-logo">{'\u26E8'}</span>
          <span>ParsePal</span>
        </div>
        {renderHeaderActions()}
      </div>
      {renderContent()}
    </div>
  );
}
