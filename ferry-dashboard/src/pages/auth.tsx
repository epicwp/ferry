import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Logo } from '../layout';

export function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/auth/${mode}`, { email, password });
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — try again.');
      setBusy(false);
    }
  };

  const login = mode === 'login';
  return (
    <div className="page-center">
      <div className="auth-panel">
        <div className="auth-panel__brand"><Logo size={30} /> Ferry</div>
        <h1>{login ? 'Welcome back' : 'Start with your first site'}</h1>
        <div className="auth-panel__sub">
          {login ? 'Log in to keep working on your sites.' : 'Connecting takes a minute. No credit card needed.'}
        </div>
        <form onSubmit={submit}>
          <label className="field">
            <span>Email</span>
            <input className="input mono" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field">
            <span>Password</span>
            <input className="input mono" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button className="btn btn--primary" type="submit" disabled={busy} style={{ width: '100%', marginTop: 4 }}>
            {login ? 'Log in' : 'Create account'}
          </button>
          {error && <div className="form-error">{error}</div>}
        </form>
        <div className="auth-panel__switch">
          {login ? 'No account yet? ' : 'Already have an account? '}
          <button onClick={() => { setMode(login ? 'signup' : 'login'); setError(''); }}>
            {login ? 'Sign up' : 'Log in'}
          </button>
        </div>
      </div>
    </div>
  );
}
