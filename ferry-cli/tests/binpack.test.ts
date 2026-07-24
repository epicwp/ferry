import { describe, expect, it } from 'vitest';
import { binPack } from '../src/transfer.js';
import { resolve } from '../src/resolve.js';

const entry = (path: string, size: number) => ({ path, size, hash: null });

describe('resolve (v0 seam)', () => {
  it('returns the manifest unchanged', () => {
    const entries = [entry('a.php', 10)];
    expect(resolve(entries)).toEqual(entries);
  });
});

describe('binPack', () => {
  it('packs greedily in order and splits oversized files', () => {
    const entries = [entry('a', 60), entry('b', 50), entry('c', 30), entry('d', 250)];
    const { batches, oversized } = binPack(entries, 100);
    expect(batches).toEqual([[entry('a', 60)], [entry('b', 50), entry('c', 30)]]);
    expect(oversized).toEqual([entry('d', 250)]);
  });

  it('handles an empty manifest', () => {
    expect(binPack([], 100)).toEqual({ batches: [], oversized: [] });
  });
});
