import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api, ApiError, discardChange, driftPreview, getChange, pushChange, rollbackChange,
  type Change, type DriftPreview, type PushStep, type PushWireEvent, type Site, type StepEvent,
} from '../api';
import { changeRef, ConfirmDialog, DiffView, OpsTable, riskOf, StatusPill, timeAgo } from '../change-parts';

const PUSH_STEPS: { id: PushStep; label: string; sub: (c: Change) => string }[] = [
  { id: 'staging', label: 'Diffs to staging directory', sub: (c) => `.ferry-staging/ · ${c.files.length} file${c.files.length === 1 ? '' : 's'}` },
  { id: 'hashes', label: 'Hashes verified', sub: () => '' },
  { id: 'drift', label: 'Drift check — compare-and-swap', sub: (c) => `file hashes + read set of ${c.ops.length + c.preconditions.length} row${c.ops.length + c.preconditions.length === 1 ? '' : 's'}` },
  { id: 'swap', label: 'Atomic rename swap with backup', sub: (c) => `backup → .ferry-backup/${(c.backupTxid ?? '').slice(0, 7)}` },
  { id: 'journal', label: 'Replay DB journal in a single transaction', sub: () => 'SELECT … FOR UPDATE → verify → apply → commit' },
  { id: 'smoke', label: 'Smoke test', sub: (c) => c.smoke.map((s) => s.label).join(' · ') },
];

interface StepState { status: 'pending' | 'active' | 'done' | 'fail'; durationMs?: number; startedAt?: number }
interface ReceivedEvent { event: PushWireEvent; at: number }

/** State-keyed reducer: the real runner emits `drift start` twice (crash-classification marker
 *  at push.ts:124 + the regular re-emission) — keying by step id makes duplicates no-ops
 *  (issue #9: double drift:start SSE emission). */
function reduceSteps(received: ReceivedEvent[]): Record<PushStep, StepState> {
  const steps = Object.fromEntries(PUSH_STEPS.map((s) => [s.id, { status: 'pending' } as StepState])) as Record<PushStep, StepState>;
  for (const { event, at } of received) {
    if (event.type !== 'push_step') continue;
    const p = event.payload as StepEvent;
    const s = steps[p.step];
    if (!s) continue;
    if (p.status === 'start' && s.status === 'pending') { s.status = 'active'; s.startedAt = at; }
    if (p.status === 'ok') { s.status = 'done'; s.durationMs = p.durationMs ?? (s.startedAt !== undefined ? at - s.startedAt : undefined); }
    if (p.status === 'fail') { s.status = 'fail'; s.durationMs = p.durationMs; }
  }
  return steps;
}

function logLines(received: ReceivedEvent[]): { at: number; text: string; ok: boolean }[] {
  const lines: { at: number; text: string; ok: boolean }[] = [];
  for (const { event, at } of received) {
    if (event.type !== 'push_step') continue;
    const p = event.payload as StepEvent;
    if (p.status === 'start' && lines.some((l) => l.text.startsWith(`${p.step}:`) )) continue; // duplicate marker
    lines.push({ at, text: `${p.step}: ${p.status}${p.detail ? ` — ${p.detail}` : ''}`, ok: p.status === 'ok' });
  }
  return lines;
}

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
        {change.status === 'pushing' && <PushingView change={change} siteId={siteId} onDone={reload} />}
        {change.status === 'pushed' && (
          <PushedView change={change} siteId={siteId} onReload={reload} actionError={actionError} setActionError={setActionError} />
        )}
        {change.status === 'rolled_back' && <RolledBackView change={change} siteId={siteId} />}
        {/* Task 11 adds the conflict view */}
      </div>
    </div>
  );
}

function PushingView({ change, siteId, onDone }: { change: Change; siteId: number; onDone: () => Promise<void> }) {
  const [received, setReceived] = useState<ReceivedEvent[]>([]);
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [startedAt]);

  useEffect(() => {
    esRef.current?.close();
    const es = new EventSource(`/api/sites/${siteId}/push/events?after=0`);
    esRef.current = es;
    es.onmessage = (ev) => {
      const event = JSON.parse(ev.data) as PushWireEvent;
      setReceived((prev) => (prev.some((r) => r.event.seq === event.seq) ? prev : [...prev, { event, at: Date.now() }]));
      if (event.type === 'push_done') void onDone();
    };
    // Poll fallback: boot recovery emits no SSE, and a lost stream must never leave an unknown
    // end state — the change row is the truth (spec §Error handling: never an unknown end state).
    const poll = setInterval(() => void onDone(), 3_000);
    return () => { es.close(); clearInterval(poll); };
  }, [siteId, onDone]);

  const steps = reduceSteps(received);
  const doneCount = PUSH_STEPS.filter((s) => steps[s.id].status === 'done').length;
  const lines = logLines(received);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return (
    <div className="push-progress">
      <div className="change-card">
        <div className="change-section">
          <div className="change-head">
            <span className="change-head__title">Pushing to production</span>
            <span className="elapsed-pill mono">pushing · {mm}:{ss}</span>
          </div>
          <p className="card__sub">Nothing is final until the last step succeeds. If anything fails, everything is rolled back.</p>
          <div className="progress"><div className="progress__bar" style={{ width: `${(doneCount / 6) * 100}%` }} /></div>
          <div className="phase-list">
            {PUSH_STEPS.map((meta) => {
              const s = steps[meta.id];
              const cls = s.status === 'done' ? 'phase phase--done' : s.status === 'active' ? 'phase phase--active' : s.status === 'fail' ? 'phase phase--fail' : 'phase phase--pending';
              return (
                <div key={meta.id} className={cls}>
                  <span className="phase__dot">{s.status === 'done' ? '✓' : s.status === 'fail' ? '!' : ''}</span>
                  <span className="phase__text">
                    <span className="phase__label">{meta.label}</span>
                    {meta.sub(change) !== '' && <span className="phase__sub mono">{meta.sub(change)}</span>}
                  </span>
                  {s.durationMs !== undefined && <span className="phase__timing mono">{(s.durationMs / 1000).toFixed(1)}s</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {lines.length > 0 && (
        <div className="push-log terminal">
          {lines.map((l, i) => (
            <div key={i}>
              <span className="terminal__prompt">{new Date(l.at).toLocaleTimeString()}</span>{' '}
              <span className={l.ok ? 'terminal__ok' : undefined}>{l.text}</span>
            </div>
          ))}
        </div>
      )}
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

function PushedView({ change, siteId, onReload, actionError, setActionError }: {
  change: Change; siteId: number; onReload: () => Promise<void>;
  actionError: string; setActionError: (e: string) => void;
}) {
  const [rollingBack, setRollingBack] = useState(false);

  async function rollBack() {
    setRollingBack(true);
    try {
      await rollbackChange(siteId, change.seq);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not roll back.');
    } finally {
      setRollingBack(false);
      // The route answers { rolledBack: true } even when the plugin-side CAS refused — the
      // change row is the truth; refetch and render whatever status it landed on.
      await onReload();
    }
  }

  return (
    <div className="pushed-wrap">
      <div className="change-card change-card--pushed">
        <div className="change-section">
          <div className="change-head">
            <span className="state-icon state-icon--ok">✓</span>
            <span className="change-head__title">Live on production</span>
          </div>
          <p className="card__sub">The change is live and all smoke checks passed.</p>
          <div className="change-meta">
            {change.pushedAt && <span>{new Date(change.pushedAt).toLocaleTimeString()}</span>}
            {change.prodRef && <span>prod @ {change.prodRef}</span>}
          </div>
        </div>
        <div className="change-section">
          <div className="section-label">Smoke test</div>
          {change.smokeResult === null ? (
            <div className="strip__sub">smoke status unknown after a server restart — verify manually.</div>
          ) : (
            change.smokeResult.map((s, i) => (
              <div key={i} className="smoke-row">
                <span className={s.ok ? 'check-dot' : 'check-dot check-dot--fail'}>{s.ok ? '✓' : '!'}</span>
                <span className="smoke-row__label">{s.label}</span>
                {s.detail && <span className="smoke-row__metric mono">{s.detail}</span>}
              </div>
            ))
          )}
        </div>
        <div className="change-section">
          <div className="strip">
            <div>
              <div className="section-label">Applied</div>
              <div style={{ fontSize: 12.5 }}>{change.files.length} files · {change.ops.length} DB operation{change.ops.length === 1 ? '' : 's'}</div>
            </div>
            <div>
              <div className="section-label">Backup</div>
              <div className="mono" style={{ fontSize: 12.5 }}>.ferry-backup/{(change.backupTxid ?? '').slice(0, 7)}</div>
            </div>
          </div>
        </div>
        {actionError !== '' && <div className="change-section"><div className="form-error">{actionError}</div></div>}
        <div className="change-actions">
          <span className="change-actions__note">Not right? Rolling back is one click — the journal is replayed in reverse.</span>
          <button type="button" className="btn btn--danger-outline" disabled={rollingBack} onClick={rollBack}>↺ Roll back</button>
        </div>
      </div>
      <p className="retention-note">The rollback button stays available as long as the backup exists — <span className="mono">30 days</span>.</p>
    </div>
  );
}

function RolledBackView({ change, siteId }: { change: Change; siteId: number }) {
  return (
    <div className="change-card">
      <div className="change-section">
        <div className="change-head">
          <span className="state-icon state-icon--neutral">↺</span>
          <span className="change-head__title">Your site is back to how it was</span>
        </div>
        <p className="card__sub">Everything from this change has been undone. The change is kept, so you can push it again later or have the agent adjust it.</p>
        <div className="change-meta">
          {change.rolledBackAt && <span>rolled back {new Date(change.rolledBackAt).toLocaleTimeString()}</span>}
          <span>prod @ {change.baseSha.slice(0, 7)}</span>
        </div>
      </div>
      <div className="change-section">
        <div className="verify-row"><span className="check-dot">✓</span><span>{change.files.length} files restored from backup</span><span className="verify-row__value mono">.ferry-backup/{(change.backupTxid ?? '').slice(0, 7)}</span></div>
        <div className="verify-row"><span className="check-dot">✓</span><span>DB journal replayed in reverse</span><span className="verify-row__value mono">{change.ops.length} operation{change.ops.length === 1 ? '' : 's'}</span></div>
        <div className="verify-row"><span className="check-dot">✓</span><span>Verification — hashes match the snapshot</span></div>
      </div>
      <div className="change-actions">
        <span className="change-actions__note">The agent branch <span className="mono">{change.branch}</span> is kept.</span>
        <Link to={`/sites/${siteId}`} className="btn btn--outline">Back to chat</Link>
        <Link
          to={`/sites/${siteId}`} className="btn btn--primary"
          state={{ prefill: `${changeRef(change.seq)} ("${change.title}") was rolled back — please take another look and adjust the fix.` }}
        >
          Let the agent adjust it
        </Link>
      </div>
    </div>
  );
}
