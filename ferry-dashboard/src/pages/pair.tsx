import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';

export function PairPage() {
  const { id } = useParams();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const raw = code.trim().toUpperCase();
    const normalized = raw.includes('-') || raw.length !== 8 ? raw : `${raw.slice(0, 4)}-${raw.slice(4)}`;
    setBusy(true);
    setError('');
    setRefused(false);
    try {
      await api.post(`/api/sites/${id}/pair`, { code: normalized });
      navigate(`/sites/${id}/sync`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setRefused(err.status === 422); // multisite: hard refusal styling
      } else {
        setError('Something went wrong — try again.');
      }
      setBusy(false);
    }
  };

  return (
    <div className="page-center">
      <div className="pair-panel">
        <div className="mono pair-panel__step">STEP 2 / 3 · PAIRING</div>
        <h1>Paste the code from the plugin</h1>
        <p>Server and plugin exchange keys. The code is single-use and expires within 10 minutes.</p>
        <form onSubmit={submit}>
          <input
            className="input mono pair-panel__code"
            aria-label="Pairing code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            maxLength={9}
            autoFocus
          />
          <button className="btn btn--primary" type="submit" disabled={busy || code.trim().length < 8}>Connect</button>
        </form>
        {error && (
          <div className={refused ? 'form-error pair-panel__refused' : 'form-error'}>
            {refused && <strong>Multisite refused · </strong>}{error}
          </div>
        )}
        <div className="pair-panel__back"><Link to="/">← Back to sites</Link></div>
      </div>
    </div>
  );
}
