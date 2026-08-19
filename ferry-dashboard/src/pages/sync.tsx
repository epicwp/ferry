import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Site, type SyncState, type TestResult } from '../api';
import { Stepper } from '../stepper';
import { timeAgo } from './sites';

const PHASES: { key: string; label: string; sub?: string }[] = [
  { key: 'info', label: 'Reading site info' },
  { key: 'manifest', label: 'Manifest & hashes fetched' },
  { key: 'resolve', label: 'Core & wp.org plugins reconstructed', sub: 'via official checksums — content-addressable cache' },
  { key: 'files', label: 'Transferring unique files' },
  { key: 'git', label: 'git init on production branch' },
  { key: 'db', label: 'Database via keyset pagination' },
  { key: 'import', label: 'Import & serve — production parity' },
];

function phaseIndex(phase: string | undefined): number {
  if (phase === 'done') return PHASES.length;
  const i = PHASES.findIndex((p) => p.key === phase);
  return i === -1 ? 0 : i;
}

export function SyncPage() {
  const { id } = useParams();
  const [site, setSite] = useState<Site | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState('');
  const [startError, setStartError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [copied, setCopied] = useState(false);
  const testedRef = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    setLoadError('');
    void api.get<Site>(`/api/sites/${id}`).then((s) => {
      setSite(s);
      if (s.status === 'paired' && !testedRef.current) {
        testedRef.current = true;
        api.post<TestResult>(`/api/sites/${id}/test`)
          .then(setTest)
          .catch((err) => setTestError(err instanceof ApiError ? err.message : 'Connection test failed.'));
      }
    }).catch((err) => {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load the site.');
    });
  }, [id]);

  useEffect(() => {
    const es = new EventSource(`/api/sites/${id}/sync/events`);
    es.onmessage = (ev) => setSync(JSON.parse(ev.data) as SyncState);
    // Do NOT close() here — that would disable EventSource's native auto-reconnect,
    // which is the actual recovery path: the server's snapshot() is now correct
    // (Fix 2a), so a reconnect self-heals to the true current state. Flipping the
    // view off a frozen `site` snapshot here would risk showing a stale error over
    // a sync that's actually still running.
    es.onerror = () => console.warn('sync SSE connection error — waiting for auto-reconnect');
    return () => es.close();
  }, [id]);

  if (loadError) {
    return (
      <div className="page-center">
        <div className="form-error">{loadError}</div>
        <Link to="/" style={{ display: 'inline-block', marginTop: 12 }}>← Back to sites</Link>
      </div>
    );
  }
  if (!site) return <div className="page-center" />;
  // Before the first SSE frame ever arrives, fall back to the persisted site
  // status so a dropped/never-connected stream still shows Retry on an already-
  // errored site. Once a live frame has arrived, `sync` is fully authoritative —
  // `site.status` is a one-time snapshot from mount and must not be consulted
  // again (it would otherwise fight a live view, e.g. showing the error card
  // over a sync that has since reached ready via a retry).
  if (!sync && site.status !== 'error') return <div className="page-center" />;
  const view: SyncState = sync ?? { status: 'error', error: site.lastError };
  const showError = view.status === 'error';

  const start = async () => {
    setStartError('');
    try {
      await api.post(`/api/sites/${id}/sync`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return; // already running — SSE resolves it anyway
      setStartError(err instanceof ApiError ? err.message : 'Could not start the sync — try again.');
    }
  };
  const copy = async () => {
    if (view.cloneUrl) {
      await navigator.clipboard.writeText(view.cloneUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const idx = phaseIndex(view.phase);
  const fraction = view.total ? (view.current ?? 0) / view.total : 0;
  const pct = Math.min(100, Math.round(((idx + fraction) / PHASES.length) * 100));

  return (
    <div className="page-center">
      <div className="sync-panel">
        <Stepper step={3} />
        <div className="sync-panel__head">
          <span className="sync-panel__avatar mono">{site.name.charAt(0).toUpperCase()}</span>
          <span className="sync-panel__title">
            <span className="sync-panel__name">{site.name}</span>
            <span className="mono sync-panel__sub">production → clone</span>
          </span>
          {view.status === 'syncing' && <span className="sync-panel__badge mono">running</span>}
          {view.status === 'ready' && <span className="sync-panel__badge sync-panel__badge--ok mono">verified</span>}
        </div>

        {view.status === 'idle' && (
          <div className="card">
            {test && <div className="sync-panel__test">✓ Connected — WordPress {test.wp} · PHP {test.php} · {test.db}</div>}
            {testError && <div className="form-error">{testError}</div>}
            {!test && !testError && site.status === 'paired' && <div className="sync-panel__testing">Testing the connection…</div>}
            {startError && <div className="form-error">{startError}</div>}
            <button className="btn btn--primary" style={{ width: '100%', marginTop: 14 }} onClick={start} disabled={!test}>
              Start first sync
            </button>
          </div>
        )}

        {view.status === 'syncing' && (
          <>
            <div className="progress"><div className="progress__bar" style={{ width: `${pct}%` }} /></div>
            <div className="phase-list">
              {PHASES.map((p, i) => {
                const state = i < idx ? 'done' : i === idx ? 'active' : 'pending';
                const counter =
                  state === 'active' && view.total !== undefined
                    ? p.key === 'db'
                      ? `${view.current ?? 0} / ${view.total} tables${view.detail ? ` · ${view.detail}` : ''}`
                      : `${view.current ?? 0} / ${view.total}`
                    : null;
                return (
                  <div key={p.key} className={`phase phase--${state}`}>
                    <span className="phase__dot">{state === 'done' ? '✓' : ''}</span>
                    <span className="phase__text">
                      <span className="phase__label">{p.label}</span>
                      {p.sub && <span className="phase__sub">{p.sub}</span>}
                    </span>
                    {counter && <span className="mono phase__counter">{counter}</span>}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {view.status === 'ready' && (
          <div className="card sync-panel__done">
            <div className="sync-panel__verified">Clone verified ✓</div>
            <div className="sync-panel__verified-sub">
              The control plane fetched the clone over HTTPS and got a live WordPress response
              {view.verifiedAt ? ` · ${timeAgo(view.verifiedAt)}` : ''}.
            </div>
            <div className="clone-url">
              <span className="mono clone-url__text">{view.cloneUrl}</span>
              <button className="btn btn--outline" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <div className="sync-panel__hint">This clone is for your agent — the URL resolves only where the clone runs.</div>
            <button className="btn btn--primary" style={{ width: '100%', marginTop: 18 }} onClick={() => navigate('/')}>
              Back to sites
            </button>
          </div>
        )}

        {showError && (
          <div className="card">
            <div className="form-error" style={{ marginTop: 0 }}>{view.error ?? site.lastError}</div>
            {startError && <div className="form-error">{startError}</div>}
            <button className="btn btn--primary" style={{ width: '100%', marginTop: 14 }} onClick={start}>
              Retry sync
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
