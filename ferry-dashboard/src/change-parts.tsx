import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getChange, pushChange, ApiError, type Change, type ChangeStatus, type DbOp } from './api';

export function changeRef(seq: number): string {
  return `CHANGE-${String(seq).padStart(4, '0')}`;
}

export function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const PILL: Record<ChangeStatus, string> = {
  draft: 'draft', pushing: 'pushing', pushed: 'pushed',
  conflict: 'conflict', rolled_back: 'rolled back', discarded: 'discarded',
};

export function StatusPill({ status }: { status: ChangeStatus }) {
  return <span className={`status-pill status-pill--${status} mono`}>{PILL[status]}</span>;
}

export function riskOf(ops: DbOp[]): { label: string; cls: string } {
  return ops.some((op) => op.kind.startsWith('row_'))
    ? { label: 'higher risk', cls: 'risk-chip--higher' }
    : { label: 'low risk', cls: 'risk-chip--low' };
}

interface DiffLine { kind: 'hunk' | 'ctx' | 'add' | 'del'; text: string }
interface DiffFile { path: string; lines: DiffLine[]; adds: number; dels: number }

export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { path: line.split(' b/').pop() ?? line, lines: [], adds: 0, dels: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    if (line.startsWith('@@')) current.lines.push({ kind: 'hunk', text: line });
    else if (line.startsWith('+')) { current.lines.push({ kind: 'add', text: line }); current.adds++; }
    else if (line.startsWith('-')) { current.lines.push({ kind: 'del', text: line }); current.dels++; }
    else current.lines.push({ kind: 'ctx', text: line });
  }
  return files;
}

export function DiffView({ diffText }: { diffText: string }) {
  const files = parseDiff(diffText);
  return (
    <>
      {files.map((f) => {
        const slash = f.path.lastIndexOf('/');
        return (
          <div key={f.path} className="diff-file">
            <div className="diff-file__head mono">
              <span className="diff-file__dir">{slash >= 0 ? f.path.slice(0, slash + 1) : ''}</span>
              <span className="diff-file__name">{slash >= 0 ? f.path.slice(slash + 1) : f.path}</span>
              <span className="diff-file__stat">
                {f.adds > 0 && <span className="diff-stat--add">+{f.adds}</span>}
                {f.dels > 0 && <span className="diff-stat--del">−{f.dels}</span>}
              </span>
            </div>
            <div className="diff-body mono">
              {f.lines.map((l, i) => <div key={i} className={`diff-line diff-line--${l.kind}`}>{l.text}</div>)}
            </div>
          </div>
        );
      })}
    </>
  );
}

function opCells(op: DbOp): { verb: string; key: string; old: string; new_: string } {
  switch (op.kind) {
    case 'option_set': return { verb: 'UPDATE', key: `options · ${op.name}`, old: op.old ?? '—', new_: op.new };
    case 'option_delete': return { verb: 'DELETE', key: `options · ${op.name}`, old: op.old, new_: '—' };
    case 'postmeta_set': return { verb: 'UPDATE', key: `postmeta · post ${op.postId} · ${op.key}`, old: op.old ?? '—', new_: op.new };
    case 'postmeta_delete': return { verb: 'DELETE', key: `postmeta · post ${op.postId} · ${op.key}`, old: op.old, new_: '—' };
    case 'row_update': return { verb: 'UPDATE', key: `${op.table} · ${op.pkCol}=${op.pk}`, old: `${Object.keys(op.old).length} columns`, new_: `${Object.keys(op.new).length} columns` };
    case 'row_insert': return { verb: 'INSERT', key: `${op.table} · ${op.pkCol}=${op.pk}`, old: '—', new_: `${Object.keys(op.new).length} columns` };
    case 'row_delete': return { verb: 'DELETE', key: `${op.table} · ${op.pkCol}=${op.pk}`, old: `${Object.keys(op.old).length} columns`, new_: '—' };
  }
}

export function OpsTable({ ops }: { ops: DbOp[] }) {
  return (
    <div className="ops-table">
      <div className="ops-table__row ops-table__row--head mono">
        <span>operation</span><span>key</span><span>old</span><span>new</span>
      </div>
      {ops.map((op, i) => {
        const c = opCells(op);
        return (
          <div key={i} className="ops-table__row mono">
            <span><span className="ops-verb">{c.verb}</span></span>
            <span className="ops-key">{c.key}</span>
            <span className="ops-old">{c.old}</span>
            <span className="ops-new">{c.new_}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onCancel }: {
  title: string; body: string; confirmLabel: string; danger: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal__title">{title}</div>
        <div className="modal__body">{body}</div>
        <div className="modal__actions">
          <button type="button" className="btn btn--outline" onClick={onCancel}>Cancel</button>
          <button type="button" className={danger ? 'btn btn--danger' : 'btn btn--push'} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function InlineChangeCard({ siteId, changeSeq, title, status }: { siteId: number; changeSeq: number; title: string; status: string }) {
  const [change, setChange] = useState<Change | null>(null);
  const [pushError, setPushError] = useState('');
  const [fetchError, setFetchError] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void getChange(siteId, changeSeq).then(setChange).catch(() => setFetchError(true));
  }, [siteId, changeSeq]);

  async function push() {
    try {
      await pushChange(siteId, changeSeq);
      navigate(`/sites/${siteId}/changes/${changeSeq}`); // watch the six steps on the change page
    } catch (err) {
      setPushError(err instanceof ApiError ? err.message : 'Could not start the push.');
    }
  }

  const files = change?.files ?? [];
  const optionOps = (change?.ops ?? []).filter((o) => o.kind === 'option_set' || o.kind === 'option_delete');

  return (
    <div className="ccard">
      <div className="ccard__head">
        <span className="state-icon state-icon--ok">✓</span>
        <span className="ccard__title">{change?.title ?? title}</span>
        <span className="ccard__ref mono">{changeRef(changeSeq)} · {change ? change.status : status}</span>
      </div>
      {change && (
        <>
          <div className="ccard__summary">“{change.summary}”</div>
          <div className="ccard__row">
            <span className="ccard__row-label">▸ {files.length} file{files.length === 1 ? '' : 's'} changed</span>
            {/* honest files list: everything the push would apply, including carried-over work */}
            <span className="ccard__row-detail mono">{files.map((f) => f.path.split('/').pop()).join(' · ')}</span>
          </div>
          {change.ops.length > 0 && (
            <div className="ccard__row">
              <span className="ccard__row-label">▸ {change.ops.length} {change.ops.length === optionOps.length ? `setting${change.ops.length === 1 ? '' : 's'}` : `DB operation${change.ops.length === 1 ? '' : 's'}`}</span>
              {optionOps.length === 1 && optionOps[0].kind === 'option_set' && (
                <span className="ccard__row-detail mono">
                  {optionOps[0].name} <span className="ccard__old">{optionOps[0].old}</span> → <span className="ccard__new">{optionOps[0].new}</span>
                </span>
              )}
            </div>
          )}
          <div className="ccard__row">
            <span className="ccard__row-label">✓ Drift check</span>
            <span className="ccard__row-detail">verified at push time inside the write transaction</span>
          </div>
          {change.smoke.length > 0 && (
            <div className="ccard__row">
              <span className="ccard__row-label mono">⚑</span>
              <span className="ccard__row-detail">
                After push I test: <strong>{change.smoke.map((s) => s.label).join(' · ')}</strong>. If the smoke test fails → automatic rollback.
              </span>
            </div>
          )}
          {pushError !== '' && <div className="ccard__row"><span className="ccard__row-detail" style={{ color: 'var(--red)' }}>{pushError}</span></div>}
        </>
      )}
      {fetchError && (
        <div className="ccard__row">
          <span className="ccard__row-detail" style={{ color: 'var(--red)' }}>Couldn't load the change details — open it via View diff.</span>
        </div>
      )}
      <div className="ccard__footer">
        <span className="ccard__note mono">nothing goes to production automatically</span>
        <Link to={`/sites/${siteId}/changes/${changeSeq}`} role="link" className="btn btn--outline btn--sm">View diff</Link>
        {change?.status === 'draft' && (
          <button type="button" className="btn btn--push btn--sm" onClick={push}>Push to production</button>
        )}
      </div>
    </div>
  );
}
