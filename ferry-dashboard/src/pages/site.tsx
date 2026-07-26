import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { agentContext, api, ApiError, type AgentContext, type Site, type SiteStatus } from '../api';
import { AgentChat } from '../chat';
import { Logo } from '../layout';

const CHIP: Record<SiteStatus, { label: string; cls: string }> = {
  new: { label: 'new', cls: 'chip--new' },
  paired: { label: 'paired', cls: 'chip--paired' },
  syncing: { label: 'syncing', cls: 'chip--syncing' },
  ready: { label: 'ready', cls: 'chip--ready' },
  error: { label: 'error', cls: 'chip--error' },
  refused_multisite: { label: 'multisite refused', cls: 'chip--refused' },
};

export function SitePage() {
  const { id } = useParams();
  const [site, setSite] = useState<Site | null>(null);
  const [context, setContext] = useState<AgentContext | null>(null);
  const [loadError, setLoadError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    setLoadError('');
    void api.get<Site>(`/api/sites/${id}`).then(setSite).catch((err) => {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load the site.');
    });
  }, [id]);

  useEffect(() => {
    void agentContext(Number(id)).then(setContext).catch((err) => {
      if (err instanceof ApiError && err.status === 409) navigate(`/sites/${id}/sync`, { replace: true });
    });
  }, [id, navigate]);

  if (loadError) {
    return (
      <div className="page-center">
        <div className="form-error">{loadError}</div>
        <Link to="/" style={{ display: 'inline-block', marginTop: 12 }}>← Back to sites</Link>
      </div>
    );
  }
  if (!site) return <div className="page-center" />;

  const chip = CHIP[site.status];

  return (
    <div className="site-grid">
      <aside className="sidebar">
        <div className="sidebar__brand"><Logo /> <span>Ferry</span></div>
        <Link to="/" className="site-sidebar__back">← All sites</Link>
        <div className="site-card">
          <span className="site-card__avatar mono">{site.name.charAt(0).toUpperCase()}</span>
          <div className="site-card__text">
            <span className="site-card__name">{site.name}</span>
            <span className={`chip ${chip.cls}`}>{chip.label}</span>
          </div>
        </div>
        <nav className="sidebar__nav">
          <span className="sidebar__item sidebar__item--disabled"><span className="sidebar__dot" />Overview</span>
          <span className="sidebar__item sidebar__item--active"><span className="sidebar__dot sidebar__dot--accent" />Agent chat</span>
          <span className="sidebar__item sidebar__item--disabled"><span className="sidebar__dot" />Changes</span>
          <Link to={`/sites/${id}/sync`} className="sidebar__item"><span className="sidebar__dot" />Sync & status</Link>
          <span className="sidebar__item sidebar__item--disabled"><span className="sidebar__dot" />Settings</span>
        </nav>
        <div className="site-sidebar__footer mono">
          <div>branch <span className="site-sidebar__accent">agent/work</span></div>
          {context && <div>base <span className="site-sidebar__muted">production@{context.baseCommit}</span></div>}
        </div>
      </aside>

      <AgentChat siteId={site.id} />

      <aside className="rail">
        <div className="rail-card">
          <div className="rail-card__title">Environment</div>
          <div className="rail-row"><span>Clone</span><span className="mono">{site.slug}.ddev.site</span></div>
          {context?.environment.wp && <div className="rail-row"><span>WordPress</span><span className="mono">{context.environment.wp}</span></div>}
          {context?.environment.php && <div className="rail-row"><span>PHP</span><span className="mono">{context.environment.php}</span></div>}
          {context?.environment.db && <div className="rail-row"><span>Database</span><span className="mono">{context.environment.db}</span></div>}
          {context?.environment.webServer && <div className="rail-row"><span>Web server</span><span className="mono">{context.environment.webServer}</span></div>}
        </div>

        <div className="rail-card">
          <div className="rail-card__title">Containment</div>
          <div className="rail-line">Egress blocked for the clone</div>
          <div className="rail-line">Mail &amp; HTTP blocked</div>
          <div className="rail-line">License stubs active (EDD, Freemius, WC.com)</div>
        </div>

        <div className="rail-card">
          <div className="rail-card__title">Changes</div>
          {context && (
            <>
              <div className="rail-card__shortstat mono">{context.shortstat || 'No changes yet'}</div>
              {context.files.map((f) => (
                <div key={f.path} className="rail-card__file mono"><span>{f.status}</span>{f.path}</div>
              ))}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
