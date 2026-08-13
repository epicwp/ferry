import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REFUSED_PREFIXES, REFUSED_TABLES } from '../src/refusals.js';

const DBOPS_PATH = fileURLToPath(new URL('../../ferry-plugin/src/DbOps.php', import.meta.url));

function phpConstArray(source: string, constName: string): string[] {
  const m = source.match(new RegExp(`const ${constName} = \\[([^\\]]*)\\]`, 's'));
  if (!m) throw new Error(`${constName} not found in DbOps.php`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

// Drift between the copies already caused one Critical (wp_-prefix hardcode) — this
// test is the tripwire the shared-source refactor cannot provide across languages.
describe('refusal-list parity: refusals.ts vs ferry-plugin DbOps.php', () => {
  const src = readFileSync(DBOPS_PATH, 'utf8');

  it('REFUSED_TABLES match exactly, in order', () => {
    expect(phpConstArray(src, 'REFUSED_TABLES')).toEqual(REFUSED_TABLES);
  });

  it('REFUSED_PATTERNS are exactly the ^-anchored TS prefixes', () => {
    expect(phpConstArray(src, 'REFUSED_PATTERNS')).toEqual(REFUSED_PREFIXES.map((p) => `/^${p}/`));
  });

  it('PHP matching is lowercased (case-insensitive) like the TS side', () => {
    expect(src).toMatch(/strtolower\(\$table\)/);
  });
});
