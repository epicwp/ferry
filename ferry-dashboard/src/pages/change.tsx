import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api, ApiError, discardChange, driftPreview, getChange, pushChange,
  type Change, type DriftPreview, type Site,
} from '../api';
import { changeRef, ConfirmDialog, DiffView, OpsTable, riskOf, StatusPill, timeAgo } from '../change-parts';

export function ChangePage() {
  const { id, seq } = useParams();
  const siteId = Number(id);
  const changeSeq = Number(seq);
  const [site, setSite] = useState<Site | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    void api.get<Site>(`/api/sites/${siteId}`).then(setSite).catch((err) => {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load the site.');
    });
  }, [siteId]);

  const reload = useCallback(async () => {
    try {
      setChange(await getChange(siteId, changeSeq));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load the change.');
    }
  }, [siteId, changeSeq]);

  useEffect(() => { void reload(); }, [reload]);

  if (loadError) return <div className="page-center"><div className="form-error">{loadError}</div></div>;
  if (!change || !site) return <div className="page-center" />;

  return (
    <div className="change-shell">
      <div className="change-topbar">
        <nav className="breadcrumb">
          <Link to="/">Sites</Link><span className="breadcrumb__sep">/</span>
          <Link to={`/sites/${siteId}`}>{site.name}</Link><span className="breadcrumb__sep">/</span>
          <Link to={`/sites/${siteId}/changes`}>Changes</Link><span className="breadcrumb__sep">/</span>
          <span className="breadcrumb__here mono">{changeRef(change.seq)}</span>
        </nav>
        <div className="change-topbar__right">
          <StatusPill status={change.status} />
          <button type="button" className="btn btn--outline btn--sm" onClick={() => navigator.clipboard.writeText(location.href)}>
            Copy link
          </button>
        </div>
      </div>
      <div className="change-body">
        {change.status === 'draft' && (
          <DraftView change={change} siteId={siteId} onReload={reload} actionError={actionError} setActionError={setActionError} navigate={navigate} />
        )}
        {change.status === 'pushing' && <div className="change-card"><div className="change-section">Pushing…</div></div>}
        {/* Tasks 9–11 replace the placeholder above and add pushed / conflict / rolled_back views */}
      </div>
    </div>
  );
}

function DraftView({ change, siteId, onReload, actionError, setActionError, navigate }: {
  change: Change; siteId: number; onReload: () => Promise<void>;
  actionError: string; setActionError: (e: string) => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [drift, setDrift] = useState<DriftPreview | null>(null);
  const [driftState, setDriftState] = useState<'checking' | 'ok' | 'bad' | 'unknown'>('checking');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const risk = riskOf(change.ops);

  useEffect(() => {
    void driftPreview(siteId, change.seq)
      .then((d) => { setDrift(d); setDriftState(d.mismatches.length === 0 ? 'ok' : 'bad'); })
      .catch(() => setDriftState('unknown'));
  }, [siteId, change.seq]);

  async function push() {
    try {
      await pushChange(siteId, change.seq);
      await onReload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not start the push.');
    }
  }

  async function discard() {
    try {
      await discardChange(siteId, change.seq);
      navigate(`/sites/${siteId}/changes`);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not discard the change.');
    }
  }

  const adds = change.diffText.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const dels = change.diffText.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

  return (
    <div className="change-card">
      <div className="change-section">
        <div className="change-head">
          <span className="state-icon state-icon--ok">✓</span>
          <span className="change-head__title">{change.title}</span>
        </div>
        <div className="change-summary">“{change.summary}”</div>
        <div className="change-meta">
          <span>{change.branch}</span>
          <span>base production@{change.baseSha.slice(0, 7)}</span>
          <span>{timeAgo(change.createdAt)}</span>
        </div>
      </div>

      <div className="change-section">
        <div className="section-head">
          <span className="section-head__title">▾ {change.files.length} file{change.files.length === 1 ? '' : 's'} changed</span>
          <span className="section-head__right"><span className="diff-stat--add">+{adds}</span> <span className="diff-stat--del">−{dels}</span></span>
        </div>
        <DiffView diffText={change.diffText} />
      </div>

      {change.ops.length > 0 && (
        <div className="change-section">
          <div className="section-head">
            <span className="section-head__title">▾ {change.ops.length} database operation{change.ops.length === 1 ? '' : 's'}</span>
            <span className={`risk-chip ${risk.cls}`}>{risk.label}</span>
            <span className="section-head__right">from binlog journal</span>
          </div>
          <OpsTable ops={change.ops} />
          <div className="ops-footnote"><span className="mono">↺</span> Rollback = replay this journal in reverse. No schema changes, no non-core tables.</div>
        </div>
      )}

      {change.preconditions.length > 0 && (
        <div className="change-section">
          <div className="section-label">The agent’s assumptions (preconditions)</div>
          {change.preconditions.map((p, i) => (
            <div key={i} className="precondition">
              <span className="check-dot">✓</span>
              {p.type === 'option' && <span><span className="mono">{p.name}</span> is still <span className="mono">{p.expected ?? 'absent'}</span></span>}
              {p.type === 'file_hash' && <span><span className="mono">{p.path}</span> hash unchanged (<span className="mono">{p.expected.slice(0, 7)}…</span>)</span>}
              {p.type === 'row' && <span><span className="mono">{p.table}.{p.column}</span> ({p.pkCol}={p.pk}) is still <span className="mono">{p.expected ?? 'absent'}</span></span>}
            </div>
          ))}
        </div>
      )}

      <div className="change-section">
        <div className="strip">
          <div>
            <div className="section-label">Drift check</div>
            {driftState === 'checking' && <div className="drift-strip__state drift-strip__state--checking">checking production…</div>}
            {driftState === 'ok' && <div className="drift-strip__state drift-strip__state--ok">production unchanged</div>}
            {driftState === 'bad' && (
              <div className="drift-strip__state drift-strip__state--bad">
                production drifted — {drift?.mismatches.length} file{drift?.mismatches.length === 1 ? '' : 's'} changed
              </div>
            )}
            {driftState === 'unknown' && <div className="drift-strip__state drift-strip__state--unknown">couldn’t check</div>}
            <div className="strip__sub">re-checked inside the write transaction</div>
          </div>
          <div>
            <div className="section-label">Smoke test after push</div>
            <div style={{ fontSize: 13 }}>{change.smoke.map((s) => s.label).join(' · ') || '—'}</div>
            <div className="strip__sub">if one fails → automatic rollback</div>
          </div>
        </div>
      </div>

      {actionError !== '' && <div className="change-section"><div className="form-error">{actionError}</div></div>}

      <div className="change-actions">
        <span className="change-actions__note">two-phase commit · atomic rename · backup</span>
        <button type="button" className="btn btn--outline" onClick={discard}>Discard</button>
        <button
          type="button" className="btn btn--push"
          onClick={() => (risk.cls === 'risk-chip--higher' ? setConfirmOpen(true) : void push())}
        >
          Push to production
        </button>
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title="Push higher-risk operations?"
          body="This change writes rows outside the options/postmeta tables. Review the DB journal above — these operations need your explicit confirmation."
          confirmLabel="Push to production"
          danger={false}
          onConfirm={() => { setConfirmOpen(false); void push(); }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
