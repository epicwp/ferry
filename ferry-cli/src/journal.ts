import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CloneEnv } from './env/ddev.js';
import { loadProfile } from './profile.js';
import type { DbOp, RiskClass } from './push-types.js';
import { isRefusedBareTable, stripTablePrefix } from './refusals.js';

const run = promisify(execFile);

export interface RawRowEvent {
  table: string;
  kind: 'update' | 'insert' | 'delete';
  /** Column names SHOW COLUMNS marked PRI for this table - empty if none, >1 if composite. */
  pkCols: string[];
  before?: Record<string, string | null>;
  after?: Record<string, string | null>;
}

/** Per-table column info resolved from `SHOW COLUMNS FROM <table>` (ordinal order + PRI flags). */
export interface TableColumns {
  fields: string[];
  pkCols: string[];
}

const HEADER_RE = /^### (UPDATE|INSERT INTO|DELETE FROM) `[^`]+`\.`([^`]+)`\s*$/;
const FIELD_RE = /^###\s+@(\d+)=(.*)$/;

/** mysqlbinlog -v prints values as SQL string literals or NULL/bare numbers - unescape accordingly. */
function unquote(raw: string): string | null {
  const value = raw.trim();
  if (value === 'NULL') return null;
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\(.)/g, (_, ch: string) => {
      switch (ch) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case '0': return '\0';
        case 'Z': return '\x1a';
        default: return ch; // covers \' \" \\ and any other escaped literal
      }
    });
  }
  return value;
}

/**
 * Line-oriented parser for `mysqlbinlog --base64-output=decode-rows -v` output (pins doc).
 * Row events carry only `@N=value` ordinals, never column names - `columns(table)` resolves
 * them (cached `SHOW COLUMNS FROM <table>` results, ordinal order).
 */
export function parseBinlog(raw: string, columns: (table: string) => TableColumns): RawRowEvent[] {
  const events: RawRowEvent[] = [];
  let current: RawRowEvent | null = null;
  let section: 'before' | 'after' | null = null;
  let cols: string[] = [];

  const flush = (): void => {
    if (current) events.push(current);
    current = null;
    section = null;
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const header = HEADER_RE.exec(rawLine);
    if (header) {
      flush();
      const kind = header[1] === 'UPDATE' ? 'update' : header[1] === 'INSERT INTO' ? 'insert' : 'delete';
      const resolved = columns(header[2]);
      current = { table: header[2], kind, pkCols: resolved.pkCols };
      cols = resolved.fields;
      continue;
    }
    if (!current) continue;
    if (rawLine === '### WHERE') { section = 'before'; continue; }
    if (rawLine === '### SET') { section = 'after'; continue; }
    const field = FIELD_RE.exec(rawLine);
    if (field && section) {
      const name = cols[Number(field[1]) - 1];
      if (name === undefined) continue; // defensive: ordinal beyond the resolved column list
      const value = unquote(field[2]);
      if (section === 'before') {
        current.before = current.before ?? {};
        current.before[name] = value;
      } else {
        current.after = current.after ?? {};
        current.after[name] = value;
      }
    }
  }
  flush();
  return events;
}

const NOISE_OPTION_RE = /^(_transient_|_site_transient_|ferry_)/;

function isNoiseOption(name: string): boolean {
  return name === 'cron' || NOISE_OPTION_RE.test(name);
}

/**
 * `DbOp.pk` is a single `number` - it cannot represent a composite key (e.g.
 * wp_term_relationships' (object_id, term_taxonomy_id)) or a non-numeric key (varchar/UUID).
 * Guessing wrong here is a wrong-row CAS hazard, so buildRowOp only proceeds when SHOW COLUMNS
 * reported exactly one PRI column and its value parses as a finite number; otherwise it signals
 * `unsupportedPk` and classify() refuses the whole event instead of emitting a bad DbOp.
 */
function buildRowOp(ev: RawRowEvent): DbOp | { unsupportedPk: true } {
  if (ev.pkCols.length !== 1) return { unsupportedPk: true }; // composite key or no PK found
  const pkCol = ev.pkCols[0];
  const row = ev.after ?? ev.before!;
  const pk = Number(row[pkCol]);
  if (!Number.isFinite(pk)) return { unsupportedPk: true }; // varchar/UUID/null key
  if (ev.kind === 'insert') {
    return { kind: 'row_insert', table: ev.table, pkCol, pk, new: ev.after! };
  }
  if (ev.kind === 'delete') {
    return { kind: 'row_delete', table: ev.table, pkCol, pk, old: ev.before! };
  }
  return { kind: 'row_update', table: ev.table, pkCol, pk, old: ev.before!, new: ev.after! };
}

function buildOptionOp(ev: RawRowEvent, name: string): DbOp {
  if (ev.kind === 'delete') {
    return { kind: 'option_delete', name, old: ev.before!.option_value! };
  }
  return { kind: 'option_set', name, old: ev.before ? ev.before.option_value : null, new: ev.after!.option_value! };
}

function buildPostmetaOp(ev: RawRowEvent): DbOp {
  const row = ev.after ?? ev.before!;
  const postId = Number(row.post_id);
  const key = row.meta_key!;
  if (ev.kind === 'delete') {
    return { kind: 'postmeta_delete', postId, key, old: ev.before!.meta_value! };
  }
  return { kind: 'postmeta_set', postId, key, old: ev.before ? ev.before.meta_value : null, new: ev.after!.meta_value! };
}

// mysqlbinlog -v's rendering of binary/BLOB columns isn't covered by any fixture or the pins
// doc (both are silent on it) - a bare `0x...` token means the decoded value can't be trusted,
// so refuse rather than guess. Revisit with a real fixture if/when a BLOB column needs support.
const HEX_LITERAL_RE = /^0x[0-9a-fA-F]+$/;

function hasBinaryValue(ev: RawRowEvent): boolean {
  const values = [...Object.values(ev.before ?? {}), ...Object.values(ev.after ?? {})];
  return values.some((v) => v !== null && HEX_LITERAL_RE.test(v));
}

/** Global Constraints classification: binary-value/pk safety guards, then noise, then content-table refusal, then option_set(delete)/postmeta_set(delete)/row_*. */
export function classify(
  ev: RawRowEvent,
  prefix: string,
): { op: DbOp; risk: RiskClass } | { noise: true } | { refused: string } {
  if (hasBinaryValue(ev)) return { refused: `binary_value_unsupported: ${ev.table}` };

  const stripped = stripTablePrefix(ev.table, prefix);

  if (stripped === 'options') {
    const name = (ev.after ?? ev.before)?.option_name ?? '';
    if (isNoiseOption(name)) return { noise: true };
    return { op: buildOptionOp(ev, name), risk: 'low' };
  }
  if (isRefusedBareTable(stripped)) return { refused: `content table: ${ev.table}` };
  if (stripped === 'postmeta') return { op: buildPostmetaOp(ev), risk: 'low' };

  const rowOp = buildRowOp(ev);
  if ('unsupportedPk' in rowOp) return { refused: `unsupported_pk: ${ev.table}` };
  return { op: rowOp, risk: 'higher' };
}

/** `SHOW COLUMNS FROM <table>` is `Field\tType\tNull\tKey\tDefault\tExtra` - Key='PRI' marks a
 *  primary-key column (every column of a composite key is marked, not just one). */
function parseShowColumns(stdout: string): TableColumns {
  const lines = stdout.trim().split('\n').slice(1).filter((l) => l.length > 0);
  const fields: string[] = [];
  const pkCols: string[] = [];
  for (const line of lines) {
    const [field, , , key] = line.split('\t');
    fields.push(field);
    if (key === 'PRI') pkCols.push(field);
  }
  return { fields, pkCols };
}

/** Table names touched, found by scanning the same `### <KIND>` headers parseBinlog reads. */
function tablesInRaw(raw: string): string[] {
  const found = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const header = HEADER_RE.exec(line);
    if (header) found.add(header[2]);
  }
  return [...found];
}

/**
 * Position from the profile (recorded at last DB import), extraction via the pinned command,
 * classification with per-table `SHOW COLUMNS` results cached for the run.
 */
export async function journalCandidates(
  slug: string,
  env: CloneEnv,
): Promise<{ ops: { op: DbOp; risk: RiskClass }[]; refusedCount: number; noiseCount: number }> {
  const profile = loadProfile(slug);
  if (!profile.binlog) {
    throw new Error(`No binlog position recorded for "${slug}" - pull the site first.`);
  }
  const docroot = profile.clonePath;
  const prefix = profile.info?.prefix ?? 'wp_';
  const raw = await env.extractBinlog(docroot, profile.binlog);

  // SHOW COLUMNS is async (shells out), so resolve every touched table's columns before parsing.
  const columnCache = new Map<string, TableColumns>();
  for (const table of tablesInRaw(raw)) {
    const { stdout } = await run('ddev', ['mysql', '-e', `SHOW COLUMNS FROM ${table}`], { cwd: docroot });
    columnCache.set(table, parseShowColumns(stdout));
  }
  const events = parseBinlog(raw, (table) => columnCache.get(table) ?? { fields: [], pkCols: [] });

  const ops: { op: DbOp; risk: RiskClass }[] = [];
  let refusedCount = 0;
  let noiseCount = 0;
  for (const ev of events) {
    const result = classify(ev, prefix);
    if ('noise' in result) { noiseCount++; continue; }
    if ('refused' in result) { refusedCount++; continue; }
    ops.push(result);
  }
  return { ops, refusedCount, noiseCount };
}

/** journal.ndjson at the clone root: one JSON-encoded DbOp per line. */
export async function writeJournal(cloneDir: string, ops: DbOp[]): Promise<void> {
  const body = ops.map((op) => JSON.stringify(op)).join('\n') + (ops.length > 0 ? '\n' : '');
  await fsp.writeFile(join(cloneDir, 'journal.ndjson'), body);
}
