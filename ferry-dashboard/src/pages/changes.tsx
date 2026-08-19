import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, listChanges, type Change, type Site } from '../api';
import { StatusPill, timeAgo } from '../change-parts';
import { SiteSidebar } from './site';

type Filter = 'all' | 'draft' | 'pushed' | 'rolled_back';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'all' }, { key: 'draft', label: 'draft' },
  { key: 'pushed', label: 'pushed' }, { key: 'rolled_back', label: 'rolled back' },
];

function rowMeta(change: Change): { text: string; failed: boolean } {
  if (change.status === 'rolled_back') {
    return { text: 'smoke test failed → rolled back automatically · no impact on prod', failed: true };
  }
  if (change.status === 'pushed') {
    const smokeText = change.smokeResult !== null && change.smokeResult.every((s) => s.ok) ? 'smoke test ✓' : 'smoke unknown';
    return { text: `pushed ${timeAgo(change.pushedAt ?? change.createdAt)} · ${smokeText} · @${change.prodRef ?? ''}`, failed: false };
  }
  const opsLabel = change.ops.length === 0 ? null
    : change.ops.every((o) => o.kind.startsWith('option_'))
      ? `${change.ops.length} setting${change.ops.length === 1 ? '' : 's'}`
      : `${change.ops.length} DB op${change.ops.length === 1 ? '' : 's'}`;
  const parts = [change.branch, `${change.files.length} file${change.files.length === 1 ? '' : 's'}`];
  if (opsLabel) parts.push(opsLabel);
  return { text: parts.join(' · '), failed: false };
}

const ICON: Record<string, string> = { pushed: '✓', rolled_back: '↺', conflict: '!' };

export function ChangesPage() {
  const { id } = useParams();
  const siteId = Number(id);
  const [site, setSite] = useState<Site | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    void api.get<Site>(`/api/sites/${siteId}`).then(setSite).catch((err) => {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load the site.');
    });
    void listChanges(siteId).then((r) => setChanges(r.changes)).catch((err) => {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load changes.');
    });
  }, [siteId]);

  if (loadError) return <div className="page-center"><div className="form-error">{loadError}</div></div>;
  if (!site || !changes) return <div className="page-center" />;

  const visible = changes.filter((c) => c.status !== 'discarded');
  const drafts = visible.filter((c) => c.status === 'draft').length;
  const shown = filter === 'all' ? visible : visible.filter((c) => c.status === filter);
  const countFor = (f: Filter) => (f === 'all' ? visible.length : visible.filter((c) => c.status === f).length);

  return (
    <div className="changes-page">
      <SiteSidebar site={site} active="changes" draftCount={drafts} />
      <main className="changes-main">
        <div className="changes__header">
          <span className="changes__title">Changes</span>
          {FILTERS.map((f) => (
            <button
              key={f.key} type="button"
              className={filter === f.key ? 'filter-pill filter-pill--active' : 'filter-pill'}
              onClick={() => setFilter(f.key)}
            >
              {f.label} {countFor(f.key)}
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <div className="empty">
            <div className="empty__inner">
              <h2>No changes yet</h2>
              <p>When the agent fixes something, the change card appears here for your approval.</p>
            </div>
          </div>
        ) : (
          <div className="change-list">
            {shown.map((c) => {
              const meta = rowMeta(c);
              return (
                <div key={c.id} className={`change-row change-row--${c.status}`}>
                  <span className={`change-row__icon change-row__icon--${c.status}`}>
                    {ICON[c.status] ?? String(c.seq).padStart(2, '0')}
                  </span>
                  <div className="change-row__text">
                    <Link to={`/sites/${siteId}/changes/${c.seq}`} className="change-row__title">{c.title}</Link>
                    <span className={meta.failed ? 'change-row__meta change-row__meta--failed' : 'change-row__meta'}>{meta.text}</span>
                  </div>
                  <StatusPill status={c.status} />
                  {c.status === 'draft' ? (
                    <Link to={`/sites/${siteId}/changes/${c.seq}`} role="button" className="btn btn--push btn--sm">Review &amp; push</Link>
                  ) : (
                    <Link to={`/sites/${siteId}/changes/${c.seq}`} className="btn btn--outline btn--sm">View</Link>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
