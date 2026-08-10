import type { ChangeStatus, DbOp } from './api';

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
