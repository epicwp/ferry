import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type Site, type SiteStatus } from '../api';
import { AppLayout } from '../layout';

const CHIP: Record<SiteStatus, { label: string; cls: string }> = {
  new: { label: 'new', cls: 'chip--new' },
  paired: { label: 'paired', cls: 'chip--paired' },
  syncing: { label: 'syncing', cls: 'chip--syncing' },
  ready: { label: 'ready', cls: 'chip--ready' },
  error: { label: 'error', cls: 'chip--error' },
  refused_multisite: { label: 'multisite refused', cls: 'chip--refused' },
};

export function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function targetFor(site: Site): string {
  if (site.status === 'new') return `/sites/${site.id}/install`;
  if (site.status === 'refused_multisite') return `/sites/${site.id}/pair`;
  if (site.status === 'ready') return `/sites/${site.id}`;
  return `/sites/${site.id}/sync`;
}

function subline(site: Site): string {
  if (site.status === 'error' && site.lastError) return site.lastError;
  if (site.status === 'refused_multisite' && site.lastError) return site.lastError;
  const synced = timeAgo(site.lastSyncAt);
  return synced ? `${site.url} · synced ${synced}` : site.url;
}

export function SitesPage() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    setLoadError('');
    void api.get<Site[]>('/api/sites').then(setSites).catch((err) => {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load your sites.');
    });
  }, []);
  if (loadError) {
    return (
      <AppLayout title="Sites">
        <div className="form-error">{loadError}</div>
      </AppLayout>
    );
  }
  if (sites === null) return <AppLayout title="Sites">{null}</AppLayout>;

  const headerRight = sites.length === 0
    ? <span className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>0 sites</span>
    : <button className="btn btn--primary" style={{ padding: '8px 14px', fontSize: 13 }} onClick={() => navigate('/sites/new')}>+ New site</button>;

  return (
    <AppLayout title="Sites" headerRight={headerRight}>
      {sites.length === 0 ? (
        <div className="empty">
          <div className="empty__inner">
            <div className="empty__placeholder"><span className="mono">no connected sites</span></div>
            <h2>Connect your first WordPress site</h2>
            <p>Ferry safely clones your production site into an isolated DDEV environment. No SSH, no FTP — one plugin and a pairing code.</p>
            <button className="btn btn--primary" onClick={() => navigate('/sites/new')}>+ New site</button>
          </div>
        </div>
      ) : (
        <div className="site-list">
          {sites.map((site) => {
            const chip = CHIP[site.status];
            const refused = site.status === 'refused_multisite';
            return (
              <div key={site.id} className={refused ? 'site-row site-row--refused' : 'site-row'}>
                <span className={refused ? 'site-row__avatar site-row__avatar--refused' : 'site-row__avatar mono'}>
                  {refused ? '!' : site.name.charAt(0).toUpperCase()}
                </span>
                <span className="site-row__text">
                  <span className="site-row__name">{site.name}</span>
                  <span className={refused ? 'site-row__sub site-row__sub--refused' : 'site-row__sub mono'}>{subline(site)}</span>
                </span>
                <span className={`chip ${chip.cls}`}>{chip.label}</span>
                <button className="btn btn--outline" style={{ padding: '7px 14px', fontSize: 13 }} onClick={() => navigate(targetFor(site))}>
                  Open
                </button>
              </div>
            );
          })}
        </div>
      )}
    </AppLayout>
  );
}
