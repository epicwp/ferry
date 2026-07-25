import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Site } from '../api';
import { AppLayout } from '../layout';
import { Stepper } from '../stepper';

export function InstallPage() {
  const { id } = useParams();
  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    void api.get<Site>(`/api/sites/${id}`).then(setSite).catch((err) => {
      setError(err instanceof ApiError ? err.message : 'Failed to load the site.');
    });
  }, [id]);

  if (error) {
    return (
      <AppLayout title="New site">
        <div className="narrow">
          <div className="form-error">{error}</div>
          <Link to="/" style={{ display: 'inline-block', marginTop: 12 }}>← Back to sites</Link>
        </div>
      </AppLayout>
    );
  }
  if (!site) return <AppLayout title="New site">{null}</AppLayout>;

  return (
    <AppLayout title="New site">
      <div className="narrow">
        <div className="breadcrumb" style={{ marginBottom: 24 }}>
          <Link to="/">Sites</Link><span className="breadcrumb__sep">/</span><span className="breadcrumb__here">{site.name}</span>
        </div>
        <Stepper step={1} />
        <div className="card">
          <h2>Install the Ferry plugin</h2>
          <div className="card__sub">
            Native PHP, no external dependencies — trivially auditable. Install it on <span className="mono">{site.url}</span>; the plugin then shows a pairing code.
          </div>
          <a className="zip-button" href="/api/plugin.zip" download>
            <span className="zip-button__title">Download .zip</span>
            <span className="zip-button__sub">ferry-connect.zip</span>
          </a>
          <div className="terminal">
            <div><span className="terminal__prompt">$</span> wp plugin install ferry-connect.zip --activate</div>
            <div className="terminal__ok">Plugin 'ferry-connect' activated.</div>
            <div><span className="terminal__prompt">$</span> wp ferry pair</div>
            <div className="terminal__note">Pairing code: <span className="terminal__code">XXXX-XXXX</span> · expires in 10:00</div>
          </div>
        </div>
        <div className="form-footer">
          <button className="btn btn--primary" onClick={() => navigate(`/sites/${site.id}/pair`)}>I have a code → pair</button>
        </div>
      </div>
    </AppLayout>
  );
}
