import { useState, FormEvent } from 'react';

interface LoginProps {
  onSuccess: (username: string) => void;
}

export default function Login({ onSuccess }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email || !password) return;

    setError('');
    setLoading(true);

    try {
      const result = await window.api.login(email, password);
      if (result.ok && result.username) {
        onSuccess(result.username);
      } else {
        setError(result.error || 'Login failed. Please check your credentials.');
      }
    } catch {
      setError('Unable to connect to server. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="content">
      <div className="login-wrapper">
        <div className="login-brand">
          <div className="login-brand-icon">{'\u26E8'}</div>
          <div className="login-brand-title">ParsePal</div>
          <div className="login-brand-subtitle">Desktop Uploader</div>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <input
            className="input"
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && <div className="error-box">{error}</div>}

          <button
            className="btn btn-primary"
            type="submit"
            disabled={loading || !email || !password}
            style={{ width: '100%', marginTop: '4px' }}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="login-footer">
          Don't have an account?{' '}
          <a
            className="link"
            onClick={() => window.api.openExternal('https://parsepal.gg')}
          >
            Sign up at parsepal.gg
          </a>
        </div>
      </div>
    </div>
  );
}
