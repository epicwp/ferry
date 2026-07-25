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
  { key: 'import', label: 'Import & DDEV up — production parity' },
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
  if (!site || !sync) return <div className="page-center" />;

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
    if (sync.cloneUrl) {
      await navigator.clipboard.writeText(sync.cloneUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const idx = phaseIndex(sync.phase);
  const fraction = sync.total ? (sync.current ?? 0) / sync.total : 0;
  const pct = Math.min(100, Math.round(((idx + fraction) / PHASES.length) * 100));

  return (
    <div className="page-center">
      <div className="sync-panel">
        <Stepper step={3} />
        <div className="sync-panel__head">
          <span className="sync-panel__avatar mono">{site.name.charAt(0).toUpperCase()}</span>
          <span className="sync-panel__title">
            <span className="sync-panel__name">{site.name}</span>
            <span className="mono sync-panel__sub">production → DDEV clone</span>
          </span>
          {sync.status === 'syncing' && <span className="sync-panel__badge mono">running</span>}
          {sync.status === 'ready' && <span className="sync-panel__badge sync-panel__badge--ok mono">verified</span>}
        </div>

        {sync.status === 'idle' && (
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

        {sync.status === 'syncing' && (
          <>
            <div className="progress"><div className="progress__bar" style={{ width: `${pct}%` }} /></div>
            <div className="phase-list">
              {PHASES.map((p, i) => {
                const state = i < idx ? 'done' : i === idx ? 'active' : 'pending';
                const counter =
                  state === 'active' && sync.total !== undefined
                    ? p.key === 'db'
                      ? `${sync.current ?? 0} / ${sync.total} tables${sync.detail ? ` · ${sync.detail}` : ''}`
                      : `${sync.current ?? 0} / ${sync.total}`
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

        {sync.status === 'ready' && (
          <div className="card sync-panel__done">
            <div className="sync-panel__verified">Clone verified ✓</div>
            <div className="sync-panel__verified-sub">
              The control plane fetched the clone over HTTPS and got a live WordPress response
              {sync.verifiedAt ? ` · ${timeAgo(sync.verifiedAt)}` : ''}.
            </div>
            <div className="clone-url">
              <span className="mono clone-url__text">{sync.cloneUrl}</span>
              <button className="btn btn--outline" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <div className="sync-panel__hint">This clone is for your agent — the URL resolves only where the clone runs.</div>
            <button className="btn btn--primary" style={{ width: '100%', marginTop: 18 }} onClick={() => navigate('/')}>
              Back to sites
            </button>
          </div>
        )}

        {sync.status === 'error' && (
          <div className="card">
            <div className="form-error" style={{ marginTop: 0 }}>{sync.error}</div>
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
