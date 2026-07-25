import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type Site } from '../api';
import { AppLayout } from '../layout';
import { Stepper } from '../stepper';

export function NewSitePage() {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const site = await api.post<Site>('/api/sites', { name, url });
      navigate(`/sites/${site.id}/install`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong — try again.');
      setBusy(false);
    }
  };

  return (
    <AppLayout title="New site">
      <div className="narrow">
        <div className="breadcrumb" style={{ marginBottom: 24 }}>
          <Link to="/">Sites</Link><span className="breadcrumb__sep">/</span><span className="breadcrumb__here">New site</span>
        </div>
        <Stepper step={1} />
        <form onSubmit={submit} className="card">
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My webshop" required />
          </label>
          <label className="field">
            <span>Site URL</span>
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" required />
          </label>
          {error && <div className="form-error">{error}</div>}
          <div className="form-footer">
            <button type="button" className="btn btn--outline" onClick={() => navigate('/')}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={busy}>Continue</button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
